/**
 * Real-Postgres fixture for the payout and booking suite: the signing
 * fixture's tenant with two CONTRACTED deals (A on a registered asset, B on
 * an unregistered one), each signed by every required signer and contracted
 * through the real staff route. Every signature is an e-signature through the
 * real portal route, except deal A's suretyships of the director and suretyA:
 * those are wet-ink scans (SIGNED_SURETYSHIP entity documents) uploaded by the
 * officer and confirmed by adminA through the real staff routes. The lender
 * identity and VAT vendor are configured, the entity has an address, and the
 * supplier has an APPROVED bank account (requested by one user, approved by
 * another). Every value is synthetic. Not a test file.
 */
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { expect } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "./dates"
import { dealStartDate } from "./deal-structure"
import { ASSET_ONE_REGISTRATION, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "./deal-signing.integration-fixture"
import { POST as confirmRoute } from "@/app/api/asset-finance/deals/[id]/checklist/[item]/route"
import { GET as panelRoute, POST as payoutRoute } from "@/app/api/asset-finance/deals/[id]/payout/route"
import { POST as approveRoute } from "@/app/api/asset-finance/deals/[id]/payout/approve/route"
import { POST as bookRoute } from "@/app/api/asset-finance/deals/[id]/book/route"
import { GET as invoiceRoute } from "@/app/api/asset-finance/tax-invoices/[id]/route"

export type SessionUser = { id: string; email: string; role: string; tenantId: string }
export type SetSession = (user: SessionUser | null) => void

export interface BookingFixture extends SigningFixture {
  dealB: string
  accountId: string
}

export const REGISTRATION = ASSET_ONE_REGISTRATION

export async function approveDeal(fx: SigningFixture, assetId: string, staff: (id: string, role: string) => void, db: PrismaClient) {
  const routes = dealRoutes(fx.host)
  staff(fx.officer, "CREDIT_OFFICER")
  const created = await routes.create({
    assetId, depositCents: 17_250_000, balloonCents: 20_000_000,
    firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2),
    preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100",
    entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
  })
  expect(created.status).toBe(201)
  const dealId = ((await created.json()) as { id: string }).id
  expect((await routes.submit(dealId)).status).toBe(200)
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
  const override = await db.ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: deal.applicationId } })
  staff(fx.adminB, "LOAN_ADMIN")
  expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
  staff(fx.officer, "CREDIT_OFFICER")
  expect((await routes.financials(dealId, {
    periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
    totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
  })).status).toBe(200)
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes.decide(dealId, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })).status).toBe(200)
  return dealId
}

/**
 * Prepare the documents (from today, the route's default), then sign every
 * signer row: the suretyships of the clients in `wetInkSureties` as wet-ink
 * scans (officer uploads, adminA confirms), every other row e-signed as its
 * client.
 */
export async function prepareAndSign(
  fx: SigningFixture, dealId: string, setSession: SetSession, db: PrismaClient, wetInkSureties: string[] = [], plannedStartDate?: string,
) {
  const routes = signingRoutes(fx.host)
  const staff = (id: string, role: string) => setSession({ id, email: `${id}@booking-it.test`, role, tenantId: fx.tenantId })
  staff(fx.officer, "CREDIT_OFFICER")
  expect((await routes.prepare(dealId, plannedStartDate ? { plannedStartDate } : undefined)).status).toBe(200)
  for (const row of await db.dealSigner.findMany({ where: { dealId } })) {
    if (row.document === "SURETYSHIP" && wetInkSureties.includes(row.clientId)) {
      staff(fx.officer, "CREDIT_OFFICER")
      expect((await routes.wetInk(dealId, row.id, "SIGNED_SURETYSHIP")).status).toBe(201)
      staff(fx.adminA, "LOAN_ADMIN")
      expect((await routes.confirm(dealId, row.id)).status).toBe(200)
      continue
    }
    setSession({ id: row.clientId, email: `${row.clientId}@booking-it.test`, role: "CLIENT", tenantId: fx.tenantId })
    expect((await routes.portalSign(row.id, { signature: `TEST ${row.clientId.slice(0, 6)} signs`, documentSha256: row.documentSha256 })).status).toBe(200)
  }
}

/** prepareAndSign, then contract. */
async function signAndContract(fx: SigningFixture, dealId: string, setSession: SetSession, db: PrismaClient, wetInkSureties: string[] = []) {
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { firstDueDate: true } })
  await prepareAndSign(fx, dealId, setSession, db, wetInkSureties, dealStartDate(deal.firstDueDate.toISOString().slice(0, 10)))
  setSession({ id: fx.officer, email: "officer@booking-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
  expect((await signingRoutes(fx.host).contract(dealId)).status).toBe(200)
}

/** The product's arrears terms while deal A's documents are prepared (copied onto it); cleared before deal B's. */
export interface BookingFixtureOptions {
  dealAArrears?: { margin: string; feeCents: number }
}

export async function createBookingFixture(
  db: PrismaClient, t: string, setSession: SetSession, options: BookingFixtureOptions = {},
): Promise<BookingFixture> {
  const tenantId = dealFixtureTenantId(t)
  const staff = (id: string, role: string) => setSession({ id, email: `${id}@booking-it.test`, role, tenantId })
  const fx = await createSigningFixture(db, t, (id, role) => staff(id, role))
  await db.tenantConfig.update({ where: { tenantId }, data: SYNTHETIC_IDENTITY })
  await db.vatConfig.create({ data: { tenantId, vatNumber: "4000000001", registeredName: SYNTHETIC_IDENTITY.legalName, address: "1 Test Street, Testville, 0001" } })
  await db.businessEntity.update({ where: { id: fx.evidenced }, data: { addressLine1: "9 Test Yard", city: "Testville", postalCode: "0002", vatNumber: "4000000002" } })
  await db.financedAsset.update({
    where: { id: fx.assets[0] },
    data: { natisTitleholder: SYNTHETIC_IDENTITY.legalName.toUpperCase() },
  })
  for (const id of fx.assets.slice(0, 2)) {
    await db.financedAsset.update({ where: { id }, data: { trackerId: `TRK-${id.slice(-6)}`, trackerProvider: "TEST Tracking", lenderNotedConfirmed: true } })
  }
  const account = await db.supplierBankAccount.create({
    data: {
      tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
      accountHolder: "TEST Plant Sales (Pty) Ltd", requestedById: fx.officer,
    },
  })
  await db.supplierBankAccount.update({
    where: { id: account.id },
    data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date(), avsResult: { manual: "company: bank letter on file" } },
  })
  const dealB = await approveDeal(fx, fx.assets[1], staff, db)
  const arrears = (terms: BookingFixtureOptions["dealAArrears"]) => db.loanProduct.update({
    where: { id: fx.product },
    data: { nonNcaDefaultInterestMargin: terms?.margin ?? null, nonNcaCollectionFeeCents: terms?.feeCents ?? null },
  })
  if (options.dealAArrears) await arrears(options.dealAArrears)
  await signAndContract(fx, fx.dealId, setSession, db, [fx.director, fx.suretyA])
  if (options.dealAArrears) await arrears(undefined)
  await signAndContract(fx, dealB, setSession, db)
  return { ...fx, dealB, accountId: account.id }
}

/** A staff-uploaded document filed on the deal (no bytes are read by the checklist). */
export async function dealDocument(db: PrismaClient, fx: BookingFixture, dealId: string, docType: "SUPPLIER_INVOICE" | "BANK_STATEMENT" | "INSURANCE_NOTING" | "TRACKER_CERTIFICATE" | "DELIVERY_ACCEPTANCE" | "NATIS_DOCUMENT") {
  return (await db.entityDocument.create({
    data: {
      tenantId: fx.tenantId, entityId: fx.evidenced, dealId, docType, fileName: `${docType.toLowerCase()}.pdf`, mimeType: "application/pdf",
      fileSize: 1, storagePath: `/nonexistent/${dealId}-${docType}.pdf`, contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
    },
  })).id
}

/** By tenant: also after a setup that failed part-way (`{ tenantId: dealFixtureTenantId(t) }`). */
export async function cleanupBookingFixture(db: PrismaClient, fx: Pick<BookingFixture, "tenantId"> | undefined): Promise<void> {
  if (!fx) return
  const tenantId = fx.tenantId
  const invoices = await db.taxInvoice.findMany({ where: { tenantId }, select: { id: true } })
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.documentAccessLog.deleteMany({ where: { documentId: { in: invoices.map((i) => i.id) } } }),
    db.taxInvoiceLine.deleteMany({ where: { invoice: { tenantId } } }),
    db.taxInvoice.deleteMany({ where: { tenantId } }),
    db.vatConfig.deleteMany({ where: { tenantId } }),
    db.payout.deleteMany({ where: { tenantId } }),
    db.payoutChecklistItem.deleteMany({ where: { tenantId } }),
    db.contractRate.deleteMany({ where: { tenantId } }),
    db.repaymentSchedule.deleteMany({ where: { tenantId } }),
    db.assetFinanceDeal.updateMany({ where: { tenantId }, data: { loanId: null } }),
    db.loan.deleteMany({ where: { tenantId } }),
    db.supplierBankAccount.deleteMany({ where: { tenantId } }),
  ])
  await cleanupSigningFixture(db, fx)
}

export function bookingRoutes(host: string) {
  const request = (path: string, method: string, json?: unknown) =>
    new NextRequest(`http://${host}${path}`, {
      method,
      headers: { host, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    })
  const base = (id: string) => `/api/asset-finance/deals/${id}`
  const deal = (id: string) => ({ params: Promise.resolve({ id }) })
  return {
    panel: (id: string) => panelRoute(request(`${base(id)}/payout`, "GET"), deal(id)),
    confirm: (id: string, item: string, body: unknown) =>
      confirmRoute(request(`${base(id)}/checklist/${item}`, "POST", body), { params: Promise.resolve({ id, item }) }),
    createPayout: (id: string) => payoutRoute(request(`${base(id)}/payout`, "POST", {}), deal(id)),
    approve: (id: string) => approveRoute(request(`${base(id)}/payout/approve`, "POST", {}), deal(id)),
    book: (id: string) => bookRoute(request(`${base(id)}/book`, "POST", {}), deal(id)),
    invoice: (id: string) => invoiceRoute(request(`/api/asset-finance/tax-invoices/${id}`, "GET"), deal(id)),
  }
}
