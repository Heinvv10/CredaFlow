import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Portal lease documents: the portal gate (lib/asset-finance/portal-route.ts),
// the lessee check (lease-portal-route.ts), loaders, renderers and the
// access-log writer run for real; session, tenant binding, Prisma, the lender
// identity and the audit writer are stubbed. withTenantContext answers 403 for a
// session of another tenant, as the real one does.
const m = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
  flag: { on: true },
  loanFindFirst: vi.fn(),
  relFindFirst: vi.fn(),
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
    entityRelationship: { findFirst: m.relFindFirst },
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

const BASE = "http://localhost/api/portal/asset-finance/leases/loan-1/documents"
const get = (kind: string, query = "") => GET(new NextRequest(`${BASE}/${kind}${query}`), { params: Promise.resolve({ loanId: "loan-1", kind }) })
const signIn = (role = "CLIENT", tenantId = "tenant-1") => { m.session.current = { user: { id: "client-1", email: "lessee@client.test", role, tenantId } } }
const refusals = () => m.logAudit.mock.calls.map(([arg]) => arg)

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn()
  m.loanFindFirst.mockResolvedValue({ entityId: "ent-1", clientId: null })
  m.relFindFirst.mockResolvedValue({ id: "rel-1" })
  m.noticeFindFirst.mockResolvedValue(NOTICE_ROW)
  m.quoteFindFirst.mockResolvedValue(QUOTE_ROW)
  m.endFindFirst.mockResolvedValue(END_ROW)
  m.readingFindFirst.mockResolvedValue(START_READING_ROW)
})

describe("GET /api/portal/asset-finance/leases/[loanId]/documents/[kind]", () => {
  it("401 without a session or with a staff session", async () => {
    m.session.current = null
    expect((await get("expiry-notice")).status).toBe(401)
    signIn("LOAN_ADMIN")
    expect((await get("expiry-notice")).status).toBe(401)
    expect(m.noticeFindFirst).not.toHaveBeenCalled()
  })

  it("403 for a session of another tenant, audited as a refused document access", async () => {
    signIn("CLIENT", "tenant-2")
    expect((await get("expiry-notice")).status).toBe(403)
    expect(refusals()).toEqual([expect.objectContaining({ action: "DOCUMENT_ACCESS_REFUSED", entity: "Loan", entityId: "loan-1", newValue: expect.objectContaining({ reason: "tenant_scope_refused", httpStatus: 403 }) })])
    expect(m.noticeFindFirst).not.toHaveBeenCalled()
  })

  it("404 when the module is off, the loan is not a lease of the tenant, or the client has no authority over the lessee entity", async () => {
    m.flag.on = false
    expect((await get("expiry-notice")).status).toBe(404)
    m.flag.on = true
    m.loanFindFirst.mockResolvedValue(null)
    expect((await get("expiry-notice")).status).toBe(404)
    m.loanFindFirst.mockResolvedValue({ entityId: "ent-1", clientId: null })
    m.relFindFirst.mockResolvedValue(null)
    expect((await get("inspection-report")).status).toBe(404)
    m.loanFindFirst.mockResolvedValue({ entityId: null, clientId: "client-other" })
    expect((await get("inspection-report")).status).toBe(404)
    expect(m.accessLogCreate).not.toHaveBeenCalled()
    expect(m.endFindFirst).not.toHaveBeenCalled()
  })

  it("404 for an unknown kind or a missing row, audited, with no access row written", async () => {
    expect((await get("nonsense")).status).toBe(404)
    m.quoteFindFirst.mockResolvedValue(null)
    expect((await get("termination-quote", "?quoteId=quote-9")).status).toBe(404)
    expect(refusals().filter((r) => r.action === "DOCUMENT_ACCESS_REFUSED")).toHaveLength(2)
    expect(m.quoteFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "quote-9", tenantId: "tenant-1", loanId: "loan-1" }) }))
    expect(m.accessLogCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["expiry-notice", "", "notice-1"],
    ["termination-quote", "?quoteId=quote-1", "quote-1"],
    ["inspection-report", "", "eot-1"],
  ])("200 application/pdf of the %s for an authorised director, logged as a client read", async (kind, query, documentId) => {
    const res = await get(kind, query)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-")
    expect(m.accessLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ documentId, accessorType: "client", accessorId: "client-1", action: "view" }) })
  })

  it("serves a sole-proprietor lessee their own lease", async () => {
    m.loanFindFirst.mockResolvedValue({ entityId: null, clientId: "client-1" })
    expect((await get("expiry-notice")).status).toBe(200)
    expect(m.relFindFirst).not.toHaveBeenCalled()
  })
})
