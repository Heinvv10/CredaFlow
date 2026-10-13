import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createHash } from "node:crypto"

// Portal contract routes (goal §4.12). The gates (lib/asset-finance/
// portal-route.ts, portal-loan-route.ts), the authority rule
// (portal-access.ts), the loader and the access-log writers run for real.
// Session, storage, PDF rendering and Prisma are stubbed; the Prisma stubs
// FILTER in-memory rows by the where clause the code builds, so a change to
// the role list or to the loan/entity binding changes the answer here. The
// real-database proof is lib/asset-finance/portal-contract.integration.test.ts.
type Rel = { clientId: string; entityId: string; role: string; active: boolean }
type Where = Record<string, unknown>
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  rels: [] as Rel[],
  accessLogCreate: vi.fn(),
  auditRefusal: vi.fn(),
  readFile: vi.fn(),
}))

const LOANS = [
  { id: "loan-1", tenantId: "tenant-1", entityId: "ent-1" },
  { id: "loan-2", tenantId: "tenant-1", entityId: "ent-2" },
  { id: "loan-consumer", tenantId: "tenant-1", entityId: null },
]
const SCHEDULE = [
  { installmentNo: 1, dueDate: new Date("2026-01-31T22:00:00Z"), principalDue: 900, interestDue: 100, feesDue: 0, totalDue: 1000, totalPaid: 1000 },
  { installmentNo: 2, dueDate: new Date("2026-02-28T22:00:00Z"), principalDue: 0, interestDue: 0, feesDue: 0, totalDue: 0, totalPaid: 0 },
  { installmentNo: 3, dueDate: new Date("2026-03-31T22:00:00Z"), principalDue: 900, interestDue: 100, feesDue: 0, totalDue: 1000, totalPaid: 400 },
  { installmentNo: 4, dueDate: new Date("2099-04-30T22:00:00Z"), principalDue: 5900, interestDue: 100, feesDue: 0, totalDue: 6000, totalPaid: 0 },
]
const SIGNERS = [
  { id: "sg-agreement", clientId: "director", document: "AGREEMENT" },
  { id: "sg-own-surety", clientId: "director", document: "SURETYSHIP" },
  { id: "sg-other-surety", clientId: "surety", document: "SURETYSHIP" },
]
const PDF = Buffer.from("%PDF-1.4 synthetic portal contract document")

const visibleTo = (where: Where, s: (typeof SIGNERS)[number]) =>
  (where.OR as Where[]).some((o) => (o.clientId !== undefined ? o.clientId === s.clientId : ((o.document as { in: string[] }).in).includes(s.document)))

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: true }) },
    entityRelationship: {
      findFirst: async ({ where }: { where: Where & { role: { in: string[] } } }) =>
        m.rels.find((r) => r.clientId === where.clientId && r.entityId === where.entityId && r.active === where.active && where.role.in.includes(r.role)) ?? null,
    },
    loan: {
      findFirst: async ({ where }: { where: Where }) => {
        const loan = LOANS.find((l) => l.id === where.id && l.tenantId === where.tenantId
          && (typeof where.entityId === "string" ? l.entityId === where.entityId : l.entityId !== null))
        if (!loan) return null
        return {
          ...loan, reference: `REF-${loan.id}`, status: "ACTIVE", contractType: "INSTALMENT_SALE", principal: 7700, balloonAmount: 5000,
          startDate: new Date("2026-01-01T00:00:00Z"), maturityDate: new Date("2099-04-30T22:00:00Z"),
          asset: { assetClass: "EXCAVATOR", make: "TEST", model: "X1", year: 2026, serialNumber: "TEST0000000000001", registrationNumber: null },
          repaymentSchedule: SCHEDULE,
          assetFinanceDeal: { id: `deal-${loan.id}`, entity: { id: loan.entityId, legalName: "TEST Earthmoving (Pty) Ltd" } },
        }
      },
    },
    contractRate: { findFirst: async () => ({ basis: "PRIME", margin: { toString: () => "0.01" }, resultingRate: { toString: () => "0.1175" }, effectiveDate: new Date("2026-01-01T00:00:00Z") }) },
    taxInvoice: {
      findFirst: async ({ where }: { where: Where }) => (where.loanId === "loan-1" || where.id === "inv-1")
        ? { id: "inv-1", invoiceNumber: "INV-000001", issueDate: new Date("2026-01-01T00:00:00Z"), totalInclVatCents: 172_500_000, lines: [] }
        : null,
    },
    dealSigner: {
      findMany: async ({ where }: { where: Where }) => SIGNERS.filter((s) => visibleTo(where, s)).map((s) => ({
        ...s, method: "E_SIGN", signedAt: new Date(), signatureSha256: "a".repeat(64), scanDocumentId: null, confirmedById: null, confirmedAt: null,
        client: { firstName: "TEST", lastName: s.clientId },
      })),
      findFirst: async ({ where }: { where: Where & { deal: { loanId: string } } }) => {
        const s = SIGNERS.find((row) => row.id === where.id && where.deal.loanId === "loan-1" && visibleTo(where, row))
        return s ? {
          id: s.id, document: s.document, documentSha256: createHash("sha256").update(PDF).digest("hex"), documentStoragePath: "/uploads/s.pdf",
          client: { firstName: "TEST", lastName: s.clientId }, deal: { application: { reference: "APP-1" } },
        } : null
      },
    },
    documentAccessLog: { create: m.accessLogCreate },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/portal/loan-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal/loan-charges")>()),
  portalLoanCharges: async () => ({ outstanding: 0, lines: [], settlementAmount: null }),
}))
vi.mock("@/lib/vat/tax-invoice-pdf", () => ({ generateTaxInvoicePdf: async () => PDF }))
vi.mock("@/lib/storage", () => ({ readFile: m.readFile, saveFile: vi.fn(), deleteFile: vi.fn() }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { GET as summary } from "./route"
import { GET as statement } from "./statement/route"
import { GET as taxInvoice } from "./tax-invoice/route"
import { GET as document } from "./documents/[signerId]/route"

const BASE = "http://localhost/api/portal/asset-finance/loans"
const asClient = (id: string) => {
  m.session.current = { user: { id, email: `${id}@client.test`, role: "CLIENT", tenantId: "tenant-1" } }
}
const loanParams = (loanId: string) => ({ params: Promise.resolve({ loanId }) })
const call = {
  summary: (loanId = "loan-1") => summary(new NextRequest(`${BASE}/${loanId}`), loanParams(loanId)),
  statement: (loanId = "loan-1") => statement(new NextRequest(`${BASE}/${loanId}/statement`), loanParams(loanId)),
  invoice: (loanId = "loan-1") => taxInvoice(new NextRequest(`${BASE}/${loanId}/tax-invoice?download=1`), loanParams(loanId)),
  document: (signerId: string, loanId = "loan-1") =>
    document(new NextRequest(`${BASE}/${loanId}/documents/${signerId}`), { params: Promise.resolve({ loanId, signerId }) }),
}
const all = (loanId: string) => Promise.all([call.summary(loanId), call.statement(loanId), call.invoice(loanId), call.document("sg-agreement", loanId)])

beforeEach(() => {
  vi.clearAllMocks()
  m.rels = [
    { clientId: "director", entityId: "ent-1", role: "DIRECTOR", active: true },
    { clientId: "director", entityId: "ent-1", role: "SURETY", active: true },
    { clientId: "surety", entityId: "ent-1", role: "SURETY", active: true },
  ]
  m.readFile.mockResolvedValue(PDF)
  asClient("director")
})

describe("portal contract routes", () => {
  it("give an authorised director the contract summary", async () => {
    const res = await call.summary()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.loan).toMatchObject({ id: "loan-1", contractType: "INSTALMENT_SALE" })
    expect(body.rate).toMatchObject({ basis: "PRIME", margin: "0.01", currentRate: "0.1175" })
    expect(body.schedule.map((r: { state: string }) => r.state)).toEqual(["PAID", "SKIP", "PARTIAL", "PENDING"])
    expect(body.schedule[3].balloonCents).toBe(5000)
    expect(body.arrears.amountCents).toBe(600)
    expect(body.nextPayment).toEqual({ dueDate: "2099-04-30T22:00:00.000Z", amountCents: 6000 })
    expect(body.taxInvoice).toMatchObject({ id: "inv-1", invoiceNumber: "INV-000001" })
    expect(body.documents.map((d: { signerId: string }) => d.signerId)).toEqual(["sg-agreement", "sg-own-surety"])
  })

  it("answer 404 everywhere to a SURETY-only client, log no access, and audit the download refusals", async () => {
    asClient("surety")
    expect((await all("loan-1")).map((r) => r.status)).toEqual([404, 404, 404, 404])
    expect(m.accessLogCreate).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledTimes(3)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ action: "DOCUMENT_ACCESS_REFUSED", entity: "Loan", entityId: "loan-1", status: 404 }))
  })

  it("answer 404 to an unrelated client", async () => {
    asClient("stranger")
    expect((await all("loan-1")).map((r) => r.status)).toEqual([404, 404, 404, 404])
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("answer 404 to the director for another entity's loan and for a consumer loan", async () => {
    expect((await all("loan-2")).map((r) => r.status)).toEqual([404, 404, 404, 404])
    expect((await all("loan-consumer")).map((r) => r.status)).toEqual([404, 404, 404, 404])
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("answer 401 to staff", async () => {
    m.session.current = { user: { id: "staff-1", email: "s@lender.test", role: "LOAN_ADMIN", tenantId: "tenant-1" } }
    expect((await call.summary()).status).toBe(401)
  })

  it("serve the tax invoice and write the access-log row against the invoice, as the client", async () => {
    const res = await call.invoice()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(m.accessLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "inv-1", accessorType: "client", accessorId: "director", action: "download" }),
    })
  })

  it("serve the agreement and the client's own suretyship, logged; another surety's suretyship is 404", async () => {
    expect((await call.document("sg-agreement")).status).toBe(200)
    expect((await call.document("sg-own-surety")).status).toBe(200)
    expect(m.accessLogCreate).toHaveBeenCalledTimes(2)
    expect(m.accessLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: "sg-agreement", accessorType: "client", accessorId: "director", action: "view" }),
    })
    expect((await call.document("sg-other-surety")).status).toBe(404)
    expect(m.accessLogCreate).toHaveBeenCalledTimes(2)
  })

  it("statement: the gate holds; until the entity renderer lands it serves nothing and logs nothing", async () => {
    expect((await call.statement()).status).toBe(503)
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })
})
