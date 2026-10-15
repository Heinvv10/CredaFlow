import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Staff lease documents: the role guard, flag gate, lease check, loaders,
// renderers and the access-log writer run for real; session, Prisma, the
// lender identity and the audit writer are stubbed. Hand-written 404s are the
// route's, not Prisma's. withTenantContext answers 403 for a session of
// another tenant, as the real one does.
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  flag: { on: true },
  loanFindFirst: vi.fn(),
  noticeFindFirst: vi.fn(),
  quoteFindFirst: vi.fn(),
  endFindFirst: vi.fn(),
  readingFindFirst: vi.fn(),
  accessLogCreate: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => m.session.current) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: {
      findUnique: async (args: { select: Record<string, boolean> }) =>
        "featureAssetFinance" in args.select ? { featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on } : { assetFinanceLegalWordingApproved: false },
    },
    loan: { findFirst: m.loanFindFirst },
    leaseExpiryNotice: { findFirst: m.noticeFindFirst },
    leaseTerminationQuote: { findFirst: m.quoteFindFirst },
    leaseEndOfTerm: { findFirst: m.endFindFirst },
    assetMeterReading: { findFirst: m.readingFindFirst },
    documentAccessLog: { create: m.accessLogCreate },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, fn: (t: { id: string }) => unknown) => {
    const { NextResponse } = await import("next/server")
    if (m.session.current && m.session.current.user.tenantId !== "tenant-1") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    return fn({ id: "tenant-1" })
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAudit: m.logAudit }))
vi.mock("@/lib/config/identity-response", async () => {
  const { LENDER } = await import("@/lib/asset-finance/documents/lease/lease-docs.fixture")
  return { lenderIdentityOrRefusal: async () => ({ identity: LENDER }) }
})

import { GET } from "./route"
import { END_ROW, NOTICE_ROW, QUOTE_ROW, START_READING_ROW } from "@/lib/asset-finance/documents/lease/lease-docs.fixture"

const BASE = "http://localhost/api/asset-finance/leases/loan-1/documents"
const get = (kind: string, query = "") => GET(new NextRequest(`${BASE}/${kind}${query}`, { headers: { "user-agent": "vitest" } }), { params: Promise.resolve({ loanId: "loan-1", kind }) })
const signIn = (role: string, tenantId = "tenant-1") => { m.session.current = { user: { id: "staff-1", email: "s@lender.test", role, tenantId } } }
const refusals = () => m.logAudit.mock.calls.map(([arg]) => arg).filter((a) => a.action === "DOCUMENT_ACCESS_REFUSED")
const refusal = (reason: string, httpStatus: number, kind = "expiry-notice") => expect.objectContaining({
  action: "DOCUMENT_ACCESS_REFUSED", entity: "Loan", entityId: "loan-1", tenantId: "tenant-1", userId: "staff-1",
  newValue: expect.objectContaining({ refused: true, reason, httpStatus, accessorType: "staff", loanId: "loan-1", kind }),
})

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("READONLY")
  m.loanFindFirst.mockResolvedValue({ id: "loan-1" })
  m.noticeFindFirst.mockResolvedValue(NOTICE_ROW)
  m.quoteFindFirst.mockResolvedValue(QUOTE_ROW)
  m.endFindFirst.mockResolvedValue(END_ROW)
  m.readingFindFirst.mockResolvedValue(START_READING_ROW)
  m.accessLogCreate.mockResolvedValue({})
})

describe("GET /api/asset-finance/leases/[loanId]/documents/[kind]", () => {
  it("401 without a session and 403 for a portal client", async () => {
    m.session.current = null
    expect((await get("expiry-notice")).status).toBe(401)
    signIn("CLIENT")
    expect((await get("expiry-notice")).status).toBe(403)
    expect(m.noticeFindFirst).not.toHaveBeenCalled()
  })

  it("404 when the asset-finance module is off, the kind is unknown, or the loan is not a lease of the tenant", async () => {
    m.flag.on = false
    expect((await get("expiry-notice")).status).toBe(404)
    m.flag.on = true
    expect((await get("nonsense")).status).toBe(404)
    m.loanFindFirst.mockResolvedValue(null)
    expect((await get("expiry-notice")).status).toBe(404)
    expect(m.loanFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "loan-1", tenantId: "tenant-1" }) }))
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("404 when the lease has no such notice, quote or inspection, and no access row is written", async () => {
    m.noticeFindFirst.mockResolvedValue(null)
    m.quoteFindFirst.mockResolvedValue(null)
    m.endFindFirst.mockResolvedValue(null)
    expect((await get("expiry-notice")).status).toBe(404)
    expect((await get("termination-quote", "?quoteId=quote-9")).status).toBe(404)
    expect((await get("inspection-report")).status).toBe(404)
    expect(m.quoteFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "quote-9", tenantId: "tenant-1", loanId: "loan-1" }) }))
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it("400 for a quote request without its quoteId", async () => {
    expect((await get("termination-quote")).status).toBe(400)
  })

  it.each([
    ["expiry-notice", "", "notice-1"],
    ["termination-quote", "?quoteId=quote-1", "quote-1"],
    ["inspection-report", "", "eot-1"],
  ])("200 application/pdf for the %s, logged before it is rendered", async (kind, query, documentId) => {
    const res = await get(kind, query)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(res.headers.get("content-disposition")).toContain(`lease-${kind}-TEST-LSE-0001.pdf`)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-")
    expect(m.accessLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId, accessorType: "staff", accessorId: "staff-1", action: "view", userAgent: "vitest" }) })
  })

  it("logs a download as a download", async () => {
    const res = await get("expiry-notice", "?download=1")
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/)
    expect(m.accessLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "download" }) })
  })

  it("fails closed: no PDF when the access-log write fails", async () => {
    m.accessLogCreate.mockRejectedValue(new Error("db down"))
    await expect(get("expiry-notice")).rejects.toThrow("db down")
  })

  it("audits every 403 and 404 as DOCUMENT_ACCESS_REFUSED, naming the cause", async () => {
    signIn("CLIENT")
    expect((await get("expiry-notice")).status).toBe(403)
    expect(refusals()).toEqual([refusal("staff_role_refused", 403)])
    m.logAudit.mockClear()
    signIn("READONLY", "tenant-2")
    expect((await get("expiry-notice")).status).toBe(403)
    expect(refusals()).toEqual([expect.objectContaining({ tenantId: "tenant-2", newValue: expect.objectContaining({ reason: "tenant_scope_refused", httpStatus: 403 }) })])
    m.logAudit.mockClear()
    signIn("READONLY")
    m.flag.on = false
    expect((await get("expiry-notice")).status).toBe(404)
    m.flag.on = true
    expect((await get("nonsense")).status).toBe(404)
    m.loanFindFirst.mockResolvedValueOnce(null)
    expect((await get("expiry-notice")).status).toBe(404)
    m.noticeFindFirst.mockResolvedValueOnce(null)
    expect((await get("expiry-notice")).status).toBe(404)
    expect(refusals()).toEqual([
      refusal("module_disabled", 404), refusal("unknown_document_kind", 404, "nonsense"), refusal("lease_not_found", 404), refusal("document_not_found", 404),
    ])
  })

  it("audits no refusal for a served document, a 401 or a 400", async () => {
    expect((await get("expiry-notice")).status).toBe(200)
    expect((await get("termination-quote")).status).toBe(400)
    m.session.current = null
    expect((await get("expiry-notice")).status).toBe(401)
    expect(refusals()).toEqual([])
  })
})
