import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const canDoMock = vi.fn()
const withTenantContextMock = vi.fn()
const queryRawMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const loanUpdateMock = vi.fn()
const logAuditStrictMock = vi.fn()
const tx = {
  $queryRaw: (...a: unknown[]) => queryRawMock(...a),
  loan: { findUnique: (a: unknown) => loanFindUniqueMock(a), update: (a: unknown) => loanUpdateMock(a) },
  auditLog: { create: vi.fn() },
}
const transactionMock = vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (r: string) => requireApiRoleMock(r),
  canDo: (...a: unknown[]) => canDoMock(...a),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (cb: never) => transactionMock(cb) } }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: (...a: unknown[]) => logAuditStrictMock(...a),
}))

import { DELETE, POST } from "./route"

const ctx = { params: Promise.resolve({ id: "L1" }) }
const req = (method: "POST" | "DELETE", body: unknown) =>
  new NextRequest("http://x/api/loans/L1/debt-review", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const startDate = new Date("2026-06-01T00:00:00+02:00")
const open = { id: "L1", clientId: "c1", status: "ACTIVE", startDate, debtReviewNoticeAt: null, debtReviewNoticeRef: null }
const underReview = {
  id: "L1",
  clientId: "c1",
  status: "ACTIVE",
  startDate,
  debtReviewNoticeAt: new Date("2026-10-01T00:00:00+02:00"),
  debtReviewNoticeRef: "DC-0001",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@example.test", role: "COLLECTIONS_OFFICER" } })
  canDoMock.mockReturnValue(true)
  withTenantContextMock.mockImplementation((_r: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }))
  loanFindUniqueMock.mockResolvedValue(open)
  loanUpdateMock.mockImplementation((a: { data: Record<string, unknown> }) => Promise.resolve({ id: "L1", ...a.data }))
  logAuditStrictMock.mockResolvedValue(undefined)
})

describe.each([
  ["POST", () => POST(req("POST", { noticeDate: "2026-10-01" }), ctx)],
  ["DELETE", () => DELETE(req("DELETE", { reason: "Notice withdrawn by the debt counsellor" }), ctx)],
] as const)("%s /api/loans/[id]/debt-review — authorisation", (_m, call) => {
  it("needs the collections role and the act_on_collections permission, and writes nothing otherwise", async () => {
    await call()
    expect(requireApiRoleMock).toHaveBeenCalledWith("COLLECTIONS_OFFICER")
    expect(canDoMock).toHaveBeenCalledWith("COLLECTIONS_OFFICER", "act_on_collections")

    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ error: new Response("no", { status: 403 }) })
    expect((await call()).status).toBe(403)

    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x", role: "INSURANCE_OFFICER" } })
    canDoMock.mockReturnValue(false)
    expect((await call()).status).toBe(403)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("passes the staff 2FA enrolment gate through unchanged (guard error returned as-is)", async () => {
    const enrolment = new Response(JSON.stringify({ error: "TOTP enrolment required" }), { status: 403 })
    requireApiRoleMock.mockResolvedValue({ error: enrolment })
    expect(await call()).toBe(enrolment)
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("is tenant-scoped: reads and writes the loan by id AND tenantId, and 404s for another tenant's loan", async () => {
    loanFindUniqueMock.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(404)
    expect(loanFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "L1", tenantId: "t1" } }))
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/loans/[id]/debt-review — record the s.86 notice", () => {
  it("stores the notice date at SAST midnight and the reference, and audits it in the same transaction", async () => {
    const res = await POST(req("POST", { noticeDate: "2026-10-01", reference: " DC-0001 " }), ctx)

    expect(res.status).toBe(200)
    // The loan row first, then the Client row (serialises with a Section 129 dispatch on a sibling loan).
    expect(queryRawMock).toHaveBeenCalledTimes(2)
    expect((queryRawMock.mock.calls[0][0] as readonly string[]).join("")).toContain('"Loan"')
    expect((queryRawMock.mock.calls[1][0] as readonly string[]).join("")).toContain('"Client"')
    expect(queryRawMock.mock.calls[1].slice(1)).toEqual(["c1", "t1"])
    expect(loanUpdateMock).toHaveBeenCalledWith({
      where: { id: "L1", tenantId: "t1" },
      data: { debtReviewNoticeAt: new Date("2026-10-01T00:00:00+02:00"), debtReviewNoticeRef: "DC-0001" },
    })
    expect(logAuditStrictMock).toHaveBeenCalledOnce()
    const [params, db] = logAuditStrictMock.mock.calls[0]
    expect(db).toBe(tx)
    expect(params).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      userEmail: "officer@example.test",
      action: "DEBT_REVIEW_NOTICE_RECORDED",
      entity: "Loan",
      entityId: "L1",
      oldValue: { debtReviewNoticeAt: null, debtReviewNoticeRef: null },
      newValue: { debtReviewNoticeAt: "2026-10-01", debtReviewNoticeRef: "DC-0001" },
    })
  })

  it("stores a null reference when none is given", async () => {
    await POST(req("POST", { noticeDate: "2026-10-01" }), ctx)
    expect(loanUpdateMock.mock.calls[0][0].data.debtReviewNoticeRef).toBeNull()
  })

  it.each([
    ["missing", {}],
    ["not a date", { noticeDate: "yesterday" }],
    ["an impossible date", { noticeDate: "2026-02-31" }],
    ["a date in the future", { noticeDate: "2999-01-01" }],
  ])("rejects a notice date that is %s with 422 and writes nothing", async (_n, body) => {
    const res = await POST(req("POST", body), ctx)
    expect(res.status).toBe(422)
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("refuses with 409 when a notice is already recorded — clear it first so the audit shows the change", async () => {
    loanFindUniqueMock.mockResolvedValue(underReview)
    const res = await POST(req("POST", { noticeDate: "2026-10-02" }), ctx)
    expect(res.status).toBe(409)
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("refuses an entity (juristic) borrower with 409: s.86 is for natural persons", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...open, clientId: null })
    const res = await POST(req("POST", { noticeDate: "2026-10-01" }), ctx)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toContain("individual consumers")
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it.each(["COMPLETED", "CANCELLED", "WRITTEN_OFF"])("refuses a %s loan with 409", async (status) => {
    loanFindUniqueMock.mockResolvedValue({ ...open, status })
    const res = await POST(req("POST", { noticeDate: "2026-10-01" }), ctx)
    expect(res.status).toBe(409)
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("rejects a notice date before the loan's start date with 422", async () => {
    const res = await POST(req("POST", { noticeDate: "2026-05-31" }), ctx)
    expect(res.status).toBe(422)
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("accepts the loan's start date itself", async () => {
    const res = await POST(req("POST", { noticeDate: "2026-06-01" }), ctx)
    expect(res.status).toBe(200)
  })

  it("rejects a reference over 100 characters with 422, and accepts exactly 100", async () => {
    expect((await POST(req("POST", { noticeDate: "2026-10-01", reference: "x".repeat(101) }), ctx)).status).toBe(422)
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect((await POST(req("POST", { noticeDate: "2026-10-01", reference: "x".repeat(100) }), ctx)).status).toBe(200)
  })

  it("treats a JSON null body as empty: 422, not a crash", async () => {
    const res = await POST(new NextRequest("http://x/api/loans/L1/debt-review", { method: "POST", body: "null" }), ctx)
    expect(res.status).toBe(422)
  })

  it("logs only the error name and code on a database failure, never the Prisma message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    transactionMock.mockRejectedValueOnce(Object.assign(new Error("Invalid `prisma.loan.update()` invocation: ref=SECRET-REF"), { code: "P2002" }))
    const res = await POST(req("POST", { noticeDate: "2026-10-01" }), ctx)
    expect(res.status).toBe(500)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain("P2002")
    expect(logged).not.toContain("SECRET-REF")
    spy.mockRestore()
  })

  it("does not claim success when the audit row cannot be written: the failure rolls the update back", async () => {
    logAuditStrictMock.mockRejectedValue(new Error("audit down"))
    const res = await POST(req("POST", { noticeDate: "2026-10-01" }), ctx)
    expect(res.status).toBe(500)
  })
})

describe("DELETE /api/loans/[id]/debt-review — clear the notice", () => {
  beforeEach(() => loanFindUniqueMock.mockResolvedValue(underReview))

  it("clears both fields and audits the reason with the values that were cleared", async () => {
    const res = await DELETE(req("DELETE", { reason: "  Notice withdrawn by the debt counsellor " }), ctx)

    expect(res.status).toBe(200)
    expect(loanUpdateMock).toHaveBeenCalledWith({
      where: { id: "L1", tenantId: "t1" },
      data: { debtReviewNoticeAt: null, debtReviewNoticeRef: null },
    })
    const [params, db] = logAuditStrictMock.mock.calls[0]
    expect(db).toBe(tx)
    expect(params).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      action: "DEBT_REVIEW_NOTICE_CLEARED",
      entity: "Loan",
      entityId: "L1",
      oldValue: { debtReviewNoticeAt: "2026-10-01", debtReviewNoticeRef: "DC-0001" },
      newValue: { debtReviewNoticeAt: null, debtReviewNoticeRef: null, reason: "Notice withdrawn by the debt counsellor" },
    })
  })

  it.each([["missing", {}], ["blank", { reason: "   " }]])("requires a reason (%s) — 422, nothing written", async (_n, body) => {
    const res = await DELETE(req("DELETE", body), ctx)
    expect(res.status).toBe(422)
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("locks the loan row first, before reading it", async () => {
    await DELETE(req("DELETE", { reason: "withdrawn" }), ctx)
    expect(queryRawMock).toHaveBeenCalledOnce()
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(loanFindUniqueMock.mock.invocationCallOrder[0])
  })

  it("can clear a notice on a closed loan: a closed loan must never trap the hold", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...underReview, status: "WRITTEN_OFF" })
    expect((await DELETE(req("DELETE", { reason: "withdrawn" }), ctx)).status).toBe(200)
  })

  it("rejects a reason over 500 characters with 422, and a JSON null body", async () => {
    expect((await DELETE(req("DELETE", { reason: "x".repeat(501) }), ctx)).status).toBe(422)
    const nullBody = new NextRequest("http://x/api/loans/L1/debt-review", { method: "DELETE", body: "null" })
    expect((await DELETE(nullBody, ctx)).status).toBe(422)
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("409s when there is nothing to clear", async () => {
    loanFindUniqueMock.mockResolvedValue(open)
    const res = await DELETE(req("DELETE", { reason: "mistake" }), ctx)
    expect(res.status).toBe(409)
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })
})
