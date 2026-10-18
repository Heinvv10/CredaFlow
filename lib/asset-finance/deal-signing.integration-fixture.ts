/**
 * Real-Postgres fixture for the deal-signing suite: the deal fixture's
 * evidenced company taken to APPROVED through the real routes, with a director
 * who is also a surety and two surety-only clients. Every value is synthetic.
 * The route helpers call the real handlers through a host that resolves to the
 * tenant. Not a test file: it has no suite of its own.
 */
import { unlink } from "node:fs/promises"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { expect } from "vitest"
import { addMonthsClamped } from "./dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealRoutes, type DealFixture } from "./deal.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"
import { GET as panelRoute, POST as prepareRoute } from "@/app/api/asset-finance/deals/[id]/signing/route"
import { POST as contractRoute } from "@/app/api/asset-finance/deals/[id]/contract/route"
import { GET as staffDocumentRoute } from "@/app/api/asset-finance/deals/[id]/signers/[signerId]/document/route"
import { POST as wetInkRoute } from "@/app/api/asset-finance/deals/[id]/signers/[signerId]/wet-ink/route"
import { POST as confirmRoute } from "@/app/api/asset-finance/deals/[id]/signers/[signerId]/confirm/route"
import { GET as portalDocumentRoute } from "@/app/api/portal/asset-finance/deal-signers/[signerId]/document/route"
import { POST as portalSignRoute } from "@/app/api/portal/asset-finance/deal-signers/[signerId]/sign/route"

export interface SigningFixture extends DealFixture {
  dealId: string
  suretyA: string
  suretyB: string
}

export const SYNTHETIC_IDENTITY = {
  legalName: "TEST Signing Lender (Pty) Ltd",
  brandName: "TEST Signing Finance",
  ncrNumber: "NCRCP00001",
  fscaNumber: "00001",
  companyRegNumber: "2000/000001/07",
  registeredOffice: "1 Test Street\nTestville\n0001",
  publicEmail: "info@lender.test",
  publicPhone: "+27 11 000 0000",
  collectionsEmail: "collections@lender.test",
  collectionsPhone: "+27 11 000 0001",
}

export async function createSigningFixture(
  db: PrismaClient,
  t: string,
  signIn: (userId: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => void,
  structure?: { periods: number; rateMargin: string },
  opts: { templates?: boolean } = {},
): Promise<SigningFixture> {
  const fx = await createDealFixture(db, t, opts)
  const client = async (label: string, n: number) =>
    (await db.client.create({
      data: {
        tenantId: fx.tenantId, firstName: "TEST", lastName: label, email: `${label}-${t}@client.invalid`,
        phone: `0001${t.slice(0, 5)}${n}`, idNumber: syntheticSaIdNumber(),
      },
    })).id
  const suretyA = await client("suretya", 1)
  const suretyB = await client("suretyb", 2)
  for (const [clientId, role] of [[fx.director, "SURETY"], [suretyA, "SURETY"], [suretyB, "SURETY"]] as const) {
    await db.entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId, role } })
  }

  if (structure) await db.loanProduct.update({ where: { id: fx.product }, data: { maxTermDays: structure.periods * 32 } })
  const routes = dealRoutes(fx.host)
  signIn(fx.officer, "CREDIT_OFFICER")
  const created = await routes.create({
    assetId: fx.assets[0], depositCents: 17_250_000, balloonCents: 20_000_000,
    firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 1),
    preset: { kind: "MONTHLY", periods: structure?.periods ?? 36 }, rateBasis: "PRIME", rateMargin: structure?.rateMargin ?? "0.0100",
    entityId: fx.evidenced, supplierId: fx.supplier, productId: fx.product,
  })
  expect(created.status).toBe(201)
  const dealId = ((await created.json()) as { id: string }).id
  expect((await routes.submit(dealId)).status).toBe(200)
  const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId } })
  const override = await db.ncaRegimeOverride.findFirstOrThrow({ where: { applicationId: deal.applicationId } })
  signIn(fx.adminB, "LOAN_ADMIN")
  expect((await routes.decideOverride(override.id, { decision: "APPROVE", note: "Synthetic AFS agree" })).status).toBe(200)
  signIn(fx.officer, "CREDIT_OFFICER")
  expect((await routes.financials(dealId, {
    periodEnd: "2026-02-28", turnoverCents: 200_000_000, ebitdaCents: 60_000_000, totalAssetsCents: 200_000_000,
    totalLiabilitiesCents: 50_000_000, existingDebtServiceCents: 10_000_000, avgMonthlyCreditsCents: 16_000_000, returnedDebitsCount: 0,
  })).status).toBe(200)
  signIn(fx.adminA, "LOAN_ADMIN")
  expect((await routes.decide(dealId, { decision: "APPROVE", reasons: ["Synthetic DSCR comfortably above policy"] })).status).toBe(200)
  // The signing suite first proves that preparation fails closed without a
  // complete lender identity; callers that need a configured lender apply
  // SYNTHETIC_IDENTITY after this fixture returns.
  await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { legalName: null } })
  return { ...fx, dealId, suretyA, suretyB }
}

/** Signer rows, documents and the files they point at go first; then the deal fixture. */
export async function cleanupSigningFixture(db: PrismaClient, fx: Pick<SigningFixture, "tenantId"> | undefined): Promise<void> {
  if (!fx) return
  const tenantId = fx.tenantId
  const signers = await db.dealSigner.findMany({ where: { tenantId }, select: { id: true, documentStoragePath: true } })
  const documents = await db.entityDocument.findMany({ where: { tenantId }, select: { id: true, storagePath: true } })
  const paths = new Set([...signers.map((s) => s.documentStoragePath), ...documents.map((d) => d.storagePath)])
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.documentAccessLog.deleteMany({ where: { documentId: { in: [...signers, ...documents].map((r) => r.id) } } }),
    db.suretyConsent.deleteMany({ where: { tenantId } }),
    db.dealSigner.deleteMany({ where: { tenantId } }),
    db.entityDocument.deleteMany({ where: { tenantId } }),
  ])
  await Promise.all([...paths].filter((p): p is string => !!p).map((p) => unlink(p).catch(() => undefined)))
  await cleanupDealFixture(db, fx)
}

export function signingRoutes(host: string) {
  const request = (path: string, method: string, init?: { json?: unknown; body?: BodyInit }) =>
    new NextRequest(`http://${host}${path}`, {
      method,
      // A client-forged first hop, then the address one trusted proxy saw (TRUSTED_PROXY=1).
      headers: { host, "x-forwarded-for": "192.0.2.66, 198.51.100.7", ...(init?.json !== undefined ? { "content-type": "application/json" } : {}) },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    })
  const deal = (id: string) => ({ params: Promise.resolve({ id }) })
  const signer = (id: string, signerId: string) => ({ params: Promise.resolve({ id, signerId }) })
  const base = (id: string) => `/api/asset-finance/deals/${id}`
  return {
    panel: (id: string) => panelRoute(request(`${base(id)}/signing`, "GET"), deal(id)),
    prepare: (id: string, body?: { plannedStartDate: string }) => prepareRoute(request(`${base(id)}/signing`, "POST", body && { json: body }), deal(id)),
    contract: (id: string) => contractRoute(request(`${base(id)}/contract`, "POST"), deal(id)),
    staffDocument: (id: string, signerId: string) =>
      staffDocumentRoute(request(`${base(id)}/signers/${signerId}/document`, "GET"), signer(id, signerId)),
    wetInk: (id: string, signerId: string, docType: string) => {
      const form = new FormData()
      form.set("docType", docType)
      form.set("file", new File([new Uint8Array(Buffer.from("%PDF-1.4 synthetic signed scan"))], "scan.pdf", { type: "application/pdf" }))
      return wetInkRoute(request(`${base(id)}/signers/${signerId}/wet-ink`, "POST", { body: form }), signer(id, signerId))
    },
    confirm: (id: string, signerId: string, scanDocumentId: string) =>
      confirmRoute(request(`${base(id)}/signers/${signerId}/confirm`, "POST", { json: { scanDocumentId } }), signer(id, signerId)),
    portalDocument: (signerId: string) =>
      portalDocumentRoute(request(`/api/portal/asset-finance/deal-signers/${signerId}/document`, "GET"), { params: Promise.resolve({ signerId }) }),
    portalSign: (signerId: string, body: unknown) =>
      portalSignRoute(request(`/api/portal/asset-finance/deal-signers/${signerId}/sign`, "POST", { json: body }), { params: Promise.resolve({ signerId }) }),
  }
}
