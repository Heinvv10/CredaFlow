/**
 * Real-Postgres fixture for the lease suites (slice 3): the deal fixture's
 * tenant (lender identity, PRIME and REPO, supplier, assets, an evidenced
 * company) plus a VAT vendor, an APPROVED supplier bank account, payout-ready
 * assets, the company's address and a sole-proprietor lessee with an address.
 * bookLease takes a lease deal through the real routes from creation to
 * booking: create, submit, credit memo, decision, documents, every signer's
 * e-signature, contract, every checklist item with its evidence, payout and
 * its second approval, book. Every value is synthetic. Not a test file.
 */
import type { PayoutChecklistItemKind, PrismaClient } from "@prisma/client"
import { expect } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "./dates"
import { createDealFixture, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { signingRoutes } from "./deal-signing.integration-fixture"
import { bookingRoutes, type SetSession } from "./payout-booking.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"
import { requiredChecklistKinds } from "./payout-checklist"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"
import { expectReproducibleIssuances } from "./documents/templates/templates.integration-fixture"

export interface LeaseFixture extends DealFixture {
  lessee: string // a sole proprietor (Client)
  lenderName: string
}

const EVIDENCE: Partial<Record<PayoutChecklistItemKind, string>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT", INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE", DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}

export async function createLeaseFixture(db: PrismaClient, t: string): Promise<LeaseFixture> {
  const fx = await createDealFixture(db, t)
  const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId }, select: { legalName: true } })
  const lenderName = config.legalName ?? ""
  await db.vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: lenderName, address: "1 Synthetic Road, Johannesburg, 2000" } })
  await db.businessEntity.update({ where: { id: fx.evidenced }, data: { addressLine1: "9 Synthetic Yard", city: "Johannesburg", postalCode: "2001", vatNumber: "4000000002" } })
  for (const id of fx.assets) {
    await db.financedAsset.update({
      where: { id },
      data: {
        trackerId: `TRK-${id.slice(-6)}`, trackerProvider: "TEST Tracking", lenderNotedConfirmed: true, natisTitleholder: lenderName, natisOwner: lenderName,
        hours: 400, odometerKm: 12_000, // the start reading of a lease with contracted usage
      },
    })
  }
  const account = await db.supplierBankAccount.create({
    data: {
      tenantId: fx.tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000001", accountNumber: "0000000001",
      accountHolder: "TEST Plant Sales (Pty) Ltd", requestedById: fx.officer,
    },
  })
  await db.supplierBankAccount.update({
    where: { id: account.id },
    data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date(), avsResult: { manual: "company: bank letter on file" } },
  })
  const lessee = (await db.client.create({
    data: {
      tenantId: fx.tenantId, firstName: "TEST", lastName: "Soleprop", email: `soleprop-${t}@client.invalid`, phone: `0002${t.slice(0, 6)}`,
      idNumber: syntheticSaIdNumber(), popiaConsentGiven: true, addressLine1: "3 Synthetic Lane", city: "Pretoria", province: "Gauteng", postalCode: "0001",
    },
  })).id
  return { ...fx, lessee, lenderName }
}

export interface LeaseBody {
  assetId: string
  contractType: "OPERATING_LEASE" | "FULL_MAINTENANCE_LEASE"
  rentalTiming: "ADVANCE" | "ARREARS"
  entityId?: string
  clientId?: string
  [key: string]: unknown
}

/** A full-maintenance or operating lease body: 36 months, PRIME + 1%, 8% escalation, R300k residual. */
export function leaseBody(fx: LeaseFixture, overrides: LeaseBody): Record<string, unknown> {
  const fml = overrides.contractType === "FULL_MAINTENANCE_LEASE"
  return {
    balloonCents: 30_000_000,
    firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
    preset: { kind: "MONTHLY", periods: 36 }, rateBasis: "PRIME", rateMargin: "0.0100",
    escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
    ...(fml ? {
      maintenanceMonthlyExclVatCents: 450_000, maintenanceEscalationRate: "0.065", maintenanceRiskModel: "LENDER_RISK",
      usageAllowancePerYear: 1_500, usageUnit: "HOURS", excessRateCents: 35_000,
    } : {}),
    supplierId: fx.supplier, productId: fx.product,
    ...overrides,
  }
}

export type Staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => void

/** Create → submit → memo → approve. Returns the deal id. */
export async function approveLease(fx: LeaseFixture, staff: Staff, body: Record<string, unknown>): Promise<string> {
  const routes = dealRoutes(fx.host)
  staff(fx.officer, "CREDIT_OFFICER")
  const created = await routes.create(body)
  const createdJson = (await created.json()) as { id?: string; error?: string }
  expect(created.status, JSON.stringify(createdJson)).toBe(201)
  const dealId = createdJson.id ?? ""
  expect((await routes.submit(dealId)).status).toBe(200)
  expect((await routes.financials(dealId, {
    periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
    totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
  })).status).toBe(200)
  staff(fx.adminA, "LOAN_ADMIN")
  const decided = await routes.decide(dealId, { decision: "APPROVE", reasons: ["Synthetic lease cover comfortably above policy"] })
  expect(decided.status, await decided.clone().text()).toBe(200)
  return dealId
}

let bareSignRefusalProved = false

/** Prepare, e-sign every signer row as its client, contract. */
export async function signLease(fx: LeaseFixture, db: PrismaClient, setSession: SetSession, dealId: string, plannedStartDate?: string): Promise<void> {
  const routes = signingRoutes(fx.host)
  setSession({ id: fx.officer, email: "officer@lease-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
  const prepared = await routes.prepare(dealId, plannedStartDate ? { plannedStartDate } : undefined)
  expect(prepared.status, await prepared.clone().text()).toBe(200)
  // The lease agreement is issued from the lender's template variant for this lease, reproducibly.
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, select: { contractType: true, cpaApplies: true } })
  const family = deal.contractType === "FULL_MAINTENANCE_LEASE" ? "af.lease.fml" : "af.lease.operating"
  expect(await expectReproducibleIssuances(db, fx.tenantId, dealId)).toContain(`${family}.${deal.cpaApplies ? "cpa" : "commercial"}`)
  for (const row of await db.dealSigner.findMany({ where: { dealId } })) {
    if (row.document === "SURETYSHIP") {
      setSession({ id: fx.officer, email: "officer@lease-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
      expect((await routes.wetInk(dealId, row.id, "SIGNED_SURETYSHIP")).status).toBe(201)
      const scan = await db.dealSigner.findUniqueOrThrow({ where: { id: row.id } })
      setSession({ id: fx.adminA, email: "admin@lease-it.test", role: "LOAN_ADMIN", tenantId: fx.tenantId })
      expect((await routes.confirm(dealId, row.id, scan.scanDocumentId!)).status).toBe(200)
      await db.suretyConsent.create({ data: { tenantId: fx.tenantId, signerId: row.id, maritalRegime: "UNMARRIED", verifiedById: fx.adminA } })
      continue
    }
    setSession({ id: row.clientId, email: `${row.clientId}@lease-it.test`, role: "CLIENT", tenantId: fx.tenantId })
    // The lender requires a signing code by default (lib/signing-otp): a lease
    // document e-signed without one is refused and stays unsigned. Proved once
    // per suite: each attempt spends the client's portal signing rate limit.
    if (!bareSignRefusalProved) {
      const bare = await routes.portalSign(row.id, { signature: `TEST ${row.clientId.slice(0, 6)} signs`, documentSha256: row.documentSha256 })
      expect(bare.status, await bare.clone().text()).toBe(403)
      expect((await db.dealSigner.findUniqueOrThrow({ where: { id: row.id }, select: { method: true } })).method).toBeNull()
      bareSignRefusalProved = true
    }
    const signingOtpChallengeId = await verifiedSigningOtp(db, {
      tenantId: fx.tenantId, clientId: row.clientId, purpose: "DEAL_DOCUMENT", subjectId: row.id, documentSha256: row.documentSha256!,
    })
    const signed = await routes.portalSign(row.id, {
      signature: `TEST ${row.clientId.slice(0, 6)} signs`, documentSha256: row.documentSha256, signingOtpChallengeId,
    })
    expect(signed.status, await signed.clone().text()).toBe(200)
  }
  setSession({ id: fx.officer, email: "officer@lease-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId })
  const contracted = await routes.contract(dealId)
  expect(contracted.status, await contracted.clone().text()).toBe(200)
}

/** Confirm every required checklist item with its synthetic evidence, as the credit officer. */
export async function confirmChecklist(fx: LeaseFixture, db: PrismaClient, staff: Staff, dealId: string): Promise<void> {
  const routes = bookingRoutes(fx.host)
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { asset: true } })
  for (const item of requiredChecklistKinds(deal.contractType, deal.asset)) {
    const docType = EVIDENCE[item]
    const evidenceDocumentId = docType ? (await db.entityDocument.create({
      data: {
        tenantId: fx.tenantId, entityId: deal.entityId, clientId: deal.entityId ? null : deal.clientId, dealId, docType: docType as never,
        fileName: `${docType.toLowerCase()}.pdf`, mimeType: "application/pdf", fileSize: 1, storagePath: `/nonexistent/${dealId}-${docType}.pdf`,
        contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
      },
    })).id : null
    staff(fx.officer, "CREDIT_OFFICER")
    const confirmed = await routes.confirm(dealId, item, { evidenceDocumentId, attestedSerial: deal.asset.serialNumber, note: null })
    expect(confirmed.status, `${item}: ${await confirmed.clone().text()}`).toBe(200)
  }
}

/** Create the payout and approve it as a second admin when it needs one. */
export async function createAndApprovePayout(fx: LeaseFixture, db: PrismaClient, staff: Staff, dealId: string): Promise<void> {
  const routes = bookingRoutes(fx.host)
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes.createPayout(dealId)).status).toBe(201)
  const payout = await db.payout.findUniqueOrThrow({ where: { dealId } })
  if (payout.status === "PENDING_APPROVAL") {
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await routes.approve(dealId)).status).toBe(200)
  }
}

/** Confirm every required checklist item, create the payout, approve it as a second admin, book. Returns the booked loan id. */
export async function payoutAndBook(fx: LeaseFixture, db: PrismaClient, staff: Staff, dealId: string): Promise<string> {
  await confirmChecklist(fx, db, staff, dealId)
  await createAndApprovePayout(fx, db, staff, dealId)
  staff(fx.adminA, "LOAN_ADMIN")
  const booked = await bookingRoutes(fx.host).book(dealId)
  const json = (await booked.json()) as { loanId?: string; error?: string }
  expect(booked.status, JSON.stringify(json)).toBe(201)
  return json.loanId ?? ""
}

/** Removes the lease rows first (triggers off), then the deal fixture's (cleanupDealFixture). */
export async function cleanupLeaseRows(db: PrismaClient, tenantId: string): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.leaseRental.deleteMany({ where: { tenantId } }),
    db.suretyConsent.deleteMany({ where: { tenantId } }),
    db.dealSigner.deleteMany({ where: { tenantId } }),
    db.entityDocument.deleteMany({ where: { tenantId } }),
  ])
}
