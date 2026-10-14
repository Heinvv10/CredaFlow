import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { authMock, accessCreate, caseFindMany, caseCreate, caseFindFirst, caseUpdateMany, caseCount, clientFindFirst, auditStrict, configFindUnique } = vi.hoisted(() => ({
  caseCount: vi.fn(),
  configFindUnique: vi.fn(),
  authMock: vi.fn(),
  accessCreate: vi.fn(),
  caseFindMany: vi.fn(),
  caseCreate: vi.fn(),
  caseFindFirst: vi.fn(),
  caseUpdateMany: vi.fn(),
  clientFindFirst: vi.fn(),
  auditStrict: vi.fn(),
}))

// The real role guard (lib/auth-guards) runs; only the session is supplied.
vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
  logAuditStrict: (...a: unknown[]) => auditStrict(...a),
}))
vi.mock("@/lib/prisma", () => {
  const db = {
    suspiciousReportAccess: { create: (a: unknown) => accessCreate(a) },
    suspiciousReportCase: {
      findMany: (a: unknown) => caseFindMany(a),
      create: (a: unknown) => caseCreate(a),
      findFirst: (a: unknown) => caseFindFirst(a),
      updateMany: (a: unknown) => caseUpdateMany(a),
      count: (a: unknown) => caseCount(a),
    },
    tenantConfig: { findUnique: (a: unknown) => configFindUnique(a) },
    client: { findFirst: (a: unknown) => clientFindFirst(a) },
    loan: { findFirst: vi.fn() },
    payment: { findFirst: vi.fn() },
  }
  return { prisma: { ...db, $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(db) } }
})

import { GET, POST } from "./route"
import { GET as GET_CASE, PATCH } from "./[id]/route"

const session = (role: string, totpVerified = true) => ({ user: { id: `u-${role}`, email: `${role.toLowerCase()}@test.invalid`, role, tenantId: "t1", totpVerified } })
const get = () => new NextRequest("http://x/api/compliance/fic/str")
const post = (body: unknown) => new NextRequest("http://x/api/compliance/fic/str", { method: "POST", body: JSON.stringify(body) })
const caseCtx = { params: Promise.resolve({ id: "case-1" }) }
const grounds = "Cash deposits just under the threshold on three consecutive days."

beforeEach(() => {
  vi.clearAllMocks()
  caseFindMany.mockResolvedValue([])
  caseCount.mockResolvedValue(0)
  configFindUnique.mockResolvedValue({ requireStaffTotp: true })
  clientFindFirst.mockResolvedValue({ id: "client-1" })
  caseCreate.mockResolvedValue({ id: "case-1", reference: "STR-20261014-ABCDEF" })
})

describe("STR register access", () => {
  it("refuses the register to every role below ADMIN, without reading or logging it", async () => {
    for (const role of ["READONLY", "COLLECTIONS_OFFICER", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "CLIENT"]) {
      authMock.mockResolvedValue(session(role))
      expect((await GET(get())).status, role).toBe(403)
      expect((await GET_CASE(get(), caseCtx)).status, role).toBe(403)
      expect((await PATCH(new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ status: "UNDER_REVIEW" }) }), caseCtx)).status, role).toBe(403)
    }
    expect(caseFindMany).not.toHaveBeenCalled()
    expect(caseUpdateMany).not.toHaveBeenCalled()
    expect(accessCreate).not.toHaveBeenCalled()
  })

  it("refuses an anonymous request", async () => {
    authMock.mockResolvedValue(null)
    expect((await GET(get())).status).toBe(401)
  })

  it("shows the register to ADMIN and logs the read", async () => {
    authMock.mockResolvedValue(session("ADMIN"))
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json()).warning).toMatch(/Tipping off is an offence/)
    expect(accessCreate).toHaveBeenCalledWith({ data: { tenantId: "t1", userId: "u-ADMIN", action: "VIEW_REGISTER", caseId: null } })
  })

  it("logs a single-case read with the case id", async () => {
    authMock.mockResolvedValue(session("SUPER_ADMIN"))
    caseFindMany.mockResolvedValue([{
      id: "case-1", reference: "STR-1", kind: "SUSPICIOUS_TRANSACTION", status: "OPEN", raisedAt: new Date(), raisedById: "u1",
      clientId: null, loanId: null, paymentId: null, client: null, loan: null, payment: null, grounds,
      assessmentNote: null, fiuReference: null, reportedAt: null, assessedAt: null, closedAt: null,
    }])
    expect((await GET_CASE(get(), caseCtx)).status).toBe(200)
    expect(accessCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "VIEW_CASE", caseId: "case-1" }) })
  })
})

describe("M5: a TOTP-verified session where the lender requires staff 2FA", () => {
  it("refuses the register, a case and an update to an ADMIN whose sign-in skipped TOTP, logging nothing", async () => {
    authMock.mockResolvedValue(session("ADMIN", false))
    expect((await GET(get())).status).toBe(403)
    expect((await GET_CASE(get(), caseCtx)).status).toBe(403)
    expect((await PATCH(new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ status: "UNDER_REVIEW" }) }), caseCtx)).status).toBe(403)
    expect(caseFindMany).not.toHaveBeenCalled()
    expect(accessCreate).not.toHaveBeenCalled()
  })

  it("allows it when the lender does not require staff 2FA", async () => {
    authMock.mockResolvedValue(session("ADMIN", false))
    configFindUnique.mockResolvedValue({ requireStaffTotp: false })
    expect((await GET(get())).status).toBe(200)
  })
})

describe("maker-checker on an STR case", () => {
  it("refuses the raiser deciding the case, but lets them start the review", async () => {
    authMock.mockResolvedValue(session("ADMIN"))
    caseFindFirst.mockResolvedValue({ status: "OPEN", raisedById: "u-ADMIN" })
    caseUpdateMany.mockResolvedValue({ count: 1 })
    const close = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ status: "CLOSED_NO_REPORT", assessmentNote: "Explained by a salary advance." }) })
    expect((await PATCH(close, caseCtx)).status).toBe(403)
    expect(caseUpdateMany).not.toHaveBeenCalled()
    const start = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ status: "UNDER_REVIEW" }) })
    expect((await PATCH(start, caseCtx)).status).toBe(200)
  })

  it("lets the raiser decide when the lender has turned the second-reviewer requirement off", async () => {
    authMock.mockResolvedValue(session("ADMIN"))
    configFindUnique.mockResolvedValue({ requireStaffTotp: true, requireSecondReviewer: false })
    caseFindFirst.mockResolvedValue({ status: "OPEN", raisedById: "u-ADMIN" })
    caseUpdateMany.mockResolvedValue({ count: 1 })
    const close = new NextRequest("http://x", { method: "PATCH", body: JSON.stringify({ status: "CLOSED_NO_REPORT", assessmentNote: "Explained by a salary advance." }) })
    expect((await PATCH(close, caseCtx)).status).toBe(200)
  })
})

describe("raising an STR", () => {
  it("lets a credit officer raise a case and returns only its reference", async () => {
    authMock.mockResolvedValue(session("CREDIT_OFFICER"))
    const res = await POST(post({ kind: "SUSPICIOUS_TRANSACTION", grounds, clientId: "client-1" }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["reference", "warning"])
    expect(auditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "STR_CASE_RAISED", newValue: { status: "OPEN" } }), expect.anything())
  })

  it("refuses READONLY, and grounds too short to say anything", async () => {
    authMock.mockResolvedValue(session("READONLY"))
    expect((await POST(post({ kind: "SUSPICIOUS_TRANSACTION", grounds, clientId: "client-1" }))).status).toBe(403)
    authMock.mockResolvedValue(session("CREDIT_OFFICER"))
    expect((await POST(post({ kind: "SUSPICIOUS_TRANSACTION", grounds: "odd", clientId: "client-1" }))).status).toBe(400)
    expect(caseCreate).not.toHaveBeenCalled()
  })

  it("refuses a subject that is not this lender's", async () => {
    authMock.mockResolvedValue(session("CREDIT_OFFICER"))
    clientFindFirst.mockResolvedValue(null)
    expect((await POST(post({ kind: "UNUSUAL_TRANSACTION", grounds, clientId: "other-tenant-client" }))).status).toBe(400)
    expect(caseCreate).not.toHaveBeenCalled()
  })
})
