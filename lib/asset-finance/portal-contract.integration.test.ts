/**
 * Real-Postgres proof of the portal contract view (goal §4.12, decision 2a.2)
 * on a deal booked through the real staff routes:
 *   - the company's director gets the contract page data and summary, the tax
 *     invoice and the agreement, and every read writes a DocumentAccessLog row;
 *   - a SURETY-only client, an unrelated client and a director of ANOTHER
 *     entity get 404 on the page, the summary, the statement, the invoice and
 *     the documents, and leave no access-log row;
 *   - a page URL pairing an entity the client may see with another entity's
 *     loan is a 404;
 *   - the director reads their own suretyship but not another surety's;
 *   - POPIA: of the entity's signed suretyship scans the director lists and
 *     downloads only their own, never another surety's (404, unlogged,
 *     audited); staff still list both.
 *
 * Only the session is stubbed. Routes, pages' gates, tenant resolution (by
 * host), feature flag, solver, VAT, storage, audit and access-log writers are
 * real.
 *
 *   RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/portal-contract.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { cleanupBookedContractFixture, createBookedContractFixture, type BookedContractFixture } from "./portal-contract.integration-fixture"
import { loadPortalContract } from "./portal-contract"
import { loadPortalEntityDocuments } from "./portal-access"
import { GET as summaryRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/route"
import { GET as statementRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/statement/route"
import { GET as invoiceRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/tax-invoice/route"
import { GET as documentRoute } from "@/app/api/portal/asset-finance/loans/[loanId]/documents/[signerId]/route"
import { GET as entityDocumentsRoute } from "@/app/api/portal/asset-finance/entities/[id]/documents/route"
import { GET as entityDocumentRoute } from "@/app/api/portal/asset-finance/entities/[id]/documents/[documentId]/route"
import { GET as staffEntityDocumentsRoute } from "@/app/api/asset-finance/entities/[id]/documents/route"
import ContractPage from "@/app/(portal)/portal/business/[entityId]/contracts/[loanId]/page"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// The page's flag read goes through unstable_cache, which needs Next's
// incremental cache; outside a Next server it reads straight through.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}))

const RUN = process.env.RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookedContractFixture
const people = { unrelated: "", otherDirector: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const asClient = (id: string) => setSession({ id, email: `${id}@contract-it.test`, role: "CLIENT", tenantId: fx.tenantId })
const get = (path: string) => new NextRequest(`http://${fx.host}/api/portal/asset-finance/loans/${path}`, { headers: { host: fx.host } })
const loan = (loanId = fx.loanId) => ({ params: Promise.resolve({ loanId }) })
const call = {
  summary: () => summaryRoute(get(fx.loanId), loan()),
  statement: () => statementRoute(get(`${fx.loanId}/statement`), loan()),
  invoice: () => invoiceRoute(get(`${fx.loanId}/tax-invoice?download=1`), loan()),
  document: (signerId: string) => documentRoute(get(`${fx.loanId}/documents/${signerId}`), { params: Promise.resolve({ loanId: fx.loanId, signerId }) }),
}
const page = (entityId: string) => ContractPage({ params: Promise.resolve({ entityId, loanId: fx.loanId }) })
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/
const signer = (clientId: string, document: "AGREEMENT" | "SURETYSHIP") =>
  database().dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, clientId, document } })
const accessRows = (accessorId: string) => database().documentAccessLog.count({ where: { accessorId } })
const newClient = async (label: string, n: number) => (await database().client.create({
  data: {
    tenantId: fx.tenantId, firstName: "TEST", lastName: label, email: `${label}-${t}@client.invalid`,
    phone: `0002${t.slice(0, 5)}${n}`, idNumber: `97${t.replace(/\D/g, "0").slice(0, 9)}${String(n).padStart(2, "0")}`,
  },
})).id

suite.sequential("portal contract view (real Postgres, booked deal, real routes)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createBookedContractFixture(database(), t, setSession)
    people.unrelated = await newClient("unrelated", 1)
    people.otherDirector = await newClient("otherdirector", 2)
    await database().entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: fx.unevidenced, clientId: people.otherDirector, role: "DIRECTOR" } })
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    await cleanupBookedContractFixture(db, fx)
    await db.$disconnect()
  })

  it("the director gets the page and the summary of the booked contract", async () => {
    asClient(fx.director)
    await expect(page(fx.evidenced)).resolves.toBeTruthy()
    const res = await call.summary()
    expect(res.status).toBe(200)
    const view = await res.json()
    const rows = await database().repaymentSchedule.findMany({ where: { loanId: fx.loanId }, orderBy: { installmentNo: "asc" } })
    expect(view).toMatchObject({
      loan: { id: fx.loanId, contractType: "INSTALMENT_SALE" },
      entity: { id: fx.evidenced, legalName: "TEST Earthmoving (Pty) Ltd" },
      balloonCents: 20_000_000,
      rate: { basis: "PRIME", currentRate: "0.1175", margin: "0.01" },
      arrears: { amountCents: 0, days: 0 },
      nextPayment: { dueDate: rows[0].dueDate.toISOString(), amountCents: rows[0].totalDue },
      taxInvoice: { totalInclVatCents: 172_500_000 },
    })
    expect(view.schedule).toHaveLength(36)
    expect(view.schedule[35].balloonCents).toBe(20_000_000)
    expect(view.outstandingCents).toBe(172_500_000 - 17_250_000)
    expect([view.chargesLive, view.chargeLines]).toEqual([false, []]) // charges off: the outstanding principal
    const visible = (view.documents as { signerId: string; document: string }[]).map((d) => d.document).sort()
    expect(visible).toEqual(["AGREEMENT", "RESOLUTION", "SURETYSHIP"]) // the director's own suretyship only
  })

  it("the director downloads the tax invoice and the agreement; each read is logged against them", async () => {
    asClient(fx.director)
    const invoice = await database().taxInvoice.findFirstOrThrow({ where: { loanId: fx.loanId } })
    const res = await call.invoice()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-")
    expect(await database().documentAccessLog.count({
      where: { documentId: invoice.id, accessorType: "client", accessorId: fx.director, action: "download" },
    })).toBe(1)

    const agreement = await signer(fx.director, "AGREEMENT")
    expect((await call.document(agreement.id)).status).toBe(200)
    expect(await database().documentAccessLog.count({ where: { documentId: agreement.id, accessorId: fx.director, action: "view" } })).toBe(1)
    expect((await call.document((await signer(fx.director, "SURETYSHIP")).id)).status).toBe(200)
  })

  it("another surety's suretyship is 404 to the director, and unlogged", async () => {
    asClient(fx.director)
    const before = await accessRows(fx.director)
    expect((await call.document((await signer(fx.suretyA, "SURETYSHIP")).id)).status).toBe(404)
    expect(await accessRows(fx.director)).toBe(before)
  })

  it("a SURETY-only client gets 404 on the page, the summary and every download, and no access row", async () => {
    asClient(fx.suretyA)
    await expect(page(fx.evidenced)).rejects.toThrow(NOT_FOUND)
    const agreement = await signer(fx.director, "AGREEMENT")
    const own = await signer(fx.suretyA, "SURETYSHIP")
    const statuses = [await call.summary(), await call.statement(), await call.invoice(), await call.document(agreement.id), await call.document(own.id)]
    expect(statuses.map((r) => r.status)).toEqual([404, 404, 404, 404, 404])
    expect(await accessRows(fx.suretyA)).toBe(0)
    expect(await database().auditLog.count({
      where: { tenantId: fx.tenantId, action: "DOCUMENT_ACCESS_REFUSED", entity: "Loan", entityId: fx.loanId },
    })).toBeGreaterThanOrEqual(2)
  })

  it("an unrelated client and another entity's director get 404 everywhere", async () => {
    for (const clientId of [people.unrelated, people.otherDirector]) {
      asClient(clientId)
      await expect(page(fx.evidenced)).rejects.toThrow(NOT_FOUND)
      const statuses = [await call.summary(), await call.statement(), await call.invoice(), await call.document((await signer(fx.director, "AGREEMENT")).id)]
      expect(statuses.map((r) => r.status)).toEqual([404, 404, 404, 404])
      expect(await accessRows(clientId)).toBe(0)
    }
  })

  it("a page URL naming an entity the client may see with another entity's loan is 404", async () => {
    asClient(people.otherDirector)
    await expect(page(fx.unevidenced)).rejects.toThrow(NOT_FOUND)
    expect(await loadPortalContract(fx.tenantId, fx.unevidenced, fx.loanId, people.otherDirector)).toBeNull()
  })

  it("serves the director the entity statement and logs the read against the loan", async () => {
    asClient(fx.director)
    const res = await call.statement()
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/pdf")
    expect(await database().documentAccessLog.count({ where: { documentId: fx.loanId } })).toBe(1)
  })

  it("POPIA: the director lists and downloads their own signed suretyship scan, never another surety's; staff see both", async () => {
    const entityGet = (path: string) => new NextRequest(`http://${fx.host}${path}`, { headers: { host: fx.host } })
    const scanOf = async (clientId: string) => (await signer(clientId, "SURETYSHIP")).scanDocumentId ?? ""
    const own = await scanOf(fx.director)
    const other = await scanOf(fx.suretyA)
    expect(own).not.toBe("")
    expect(other).not.toBe("")
    const download = (documentId: string) => entityDocumentRoute(
      entityGet(`/api/portal/asset-finance/entities/${fx.evidenced}/documents/${documentId}?download=1`),
      { params: Promise.resolve({ id: fx.evidenced, documentId }) },
    )

    asClient(fx.director)
    const list = await entityDocumentsRoute(entityGet(`/api/portal/asset-finance/entities/${fx.evidenced}/documents`), { params: Promise.resolve({ id: fx.evidenced }) })
    expect(list.status).toBe(200)
    const listed = ((await list.json()) as { id: string; docType: string }[])
    const ownScans = await database().dealSigner.findMany({ where: { tenantId: fx.tenantId, clientId: fx.director, document: "SURETYSHIP", deal: { entityId: fx.evidenced } }, select: { scanDocumentId: true } })
    expect(listed.filter((d) => d.docType === "SIGNED_SURETYSHIP").map((d) => d.id).sort()).toEqual(ownScans.map((s) => s.scanDocumentId).sort())
    // The portal entity page renders the same loader.
    expect((await loadPortalEntityDocuments(fx.tenantId, fx.evidenced, fx.director)).map((d) => d.id)).toEqual(listed.map((d) => d.id))

    expect((await download(other)).status).toBe(404)
    expect(await database().documentAccessLog.count({ where: { documentId: other } })).toBe(0)
    expect(await database().auditLog.count({
      where: { tenantId: fx.tenantId, action: "DOCUMENT_ACCESS_REFUSED", entity: "EntityDocument", entityId: other },
    })).toBe(1)
    expect((await download(own)).status).toBe(200)
    expect(await database().documentAccessLog.count({ where: { documentId: own, accessorId: fx.director, action: "download" } })).toBe(1)

    setSession({ id: fx.officer, email: `${fx.officer}@contract-it.test`, role: "CREDIT_OFFICER", tenantId: fx.tenantId })
    const staff = await staffEntityDocumentsRoute(entityGet(`/api/asset-finance/entities/${fx.evidenced}/documents`), { params: Promise.resolve({ id: fx.evidenced }) })
    expect(staff.status).toBe(200)
    const staffScans = ((await staff.json()) as { id: string; docType: string }[]).filter((d) => d.docType === "SIGNED_SURETYSHIP").map((d) => d.id)
    const allScans = await database().entityDocument.findMany({ where: { tenantId: fx.tenantId, entityId: fx.evidenced, docType: "SIGNED_SURETYSHIP", deletedAt: null }, select: { id: true } })
    expect(staffScans.sort()).toEqual(allScans.map((d) => d.id).sort())
    expect(staffScans).toEqual(expect.arrayContaining([own, other]))
  })
})
