import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    ncaRegimeOverride: { findFirst: vi.fn(), update: vi.fn() },
    loanApplication: { update: vi.fn() },
  }
  return {
    tx,
    flag: { on: true },
    transaction: vi.fn(),
    transactionError: { current: null as Error | null },
    findOverride: vi.fn(),
    requireApiRole: vi.fn(),
    logAuditStrict: vi.fn(),
    auditRefusal: vi.fn(),
  }
})

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    ncaRegimeOverride: { findFirst: m.findOverride },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      m.transaction()
      if (m.transactionError.current) throw m.transactionError.current
      return fn(m.tx)
    },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
// Only the session guard is mocked: canDo is the real permission map.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { POST } from "./route"

const signIn = (id: string, role: string) =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })

/** The application as it stands; by default exactly the one the override was requested on. */
const app = (over: Record<string, unknown> = {}) => ({
  status: "UNDER_REVIEW", ncaRegime: "NCA", entityId: "ent-1", appliedAmount: 150_000_000, productId: "prod-1",
  ncaClassificationRule: "JURISTIC_OVER_THRESHOLD", ...over,
})

const pending = (over: Record<string, unknown> = {}) => ({
  id: "ov-1",
  tenantId: "tenant-1",
  applicationId: "app-1",
  fromRegime: "NCA",
  toRegime: "NON_NCA",
  reason: "Audited AFS show R4m turnover",
  status: "PENDING",
  requestedById: "admin-a",
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  approvedEntityId: "ent-1",
  approvedAppliedAmount: 150_000_000,
  approvedProductId: "prod-1",
  approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
  application: app(),
  ...over,
})

const decide = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/asset-finance/nca-overrides/ov-1/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ overrideId: "ov-1" }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  m.transactionError.current = null
  signIn("admin-b", "LOAN_ADMIN")
  m.findOverride.mockResolvedValue({ applicationId: "app-1" })
  m.tx.$queryRaw.mockResolvedValue([{ id: "locked" }])
  m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending())
  m.tx.ncaRegimeOverride.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...pending(), ...data }))
})

describe("POST /api/asset-finance/nca-overrides/[overrideId]/decide", () => {
  it("answers 404 when the tenant has not enabled asset finance", async () => {
    m.flag.on = false
    const res = await decide({ decision: "APPROVE", note: "Checked" })
    expect(res.status).toBe(404)
    expect(m.findOverride).not.toHaveBeenCalled()
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("refuses a CREDIT_OFFICER 403 and audits the refusal", async () => {
    signIn("officer-c", "CREDIT_OFFICER")
    const res = await decide({ decision: "APPROVE", note: "Checked" })
    expect(res.status).toBe(403)
    expect(m.transaction).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECISION_REFUSED", entityId: "ov-1", userId: "officer-c", reason: "insufficient_role", status: 403,
    }))
  })

  it("refuses the requester deciding their own override 403, audited, writing nothing", async () => {
    signIn("admin-a", "LOAN_ADMIN")
    const res = await decide({ decision: "APPROVE", note: "Approving my own" })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/other than its requester/)
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECISION_REFUSED", userId: "admin-a", reason: "four_eyes_self_decision", status: 403,
    }))
  })

  it("refuses the requester rejecting their own override too", async () => {
    signIn("admin-a", "LOAN_ADMIN")
    expect((await decide({ decision: "REJECT", note: "Withdrawing it" })).status).toBe(403)
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
  })

  it.each([
    [{ decision: "APPROVE", note: "ok" }, /note/],
    [{ decision: "APPROVE", note: "    ok      " }, /note/],
    [{ decision: "APPROVE" }, /note/],
    [{ decision: "MAYBE", note: "Checked" }, /decision/],
    [null, /JSON object/],
  ])("answers 400 for %j", async (body, message) => {
    const res = await decide(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 404 for an override outside the tenant", async () => {
    m.findOverride.mockResolvedValue(null)
    const res = await decide({ decision: "APPROVE", note: "Checked" })
    expect(res.status).toBe(404)
    expect(m.findOverride).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ov-1", tenantId: "tenant-1" } }))
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("answers 409 for an override that is no longer pending", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ status: "REJECTED", decidedById: "x", decidedAt: new Date() }))
    expect((await decide({ decision: "APPROVE", note: "Checked" })).status).toBe(409)
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
  })

  it("APPROVE on a stale request (the regime moved) rejects it as stale: 409, regime untouched", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ application: app({ status: "UNDER_REVIEW", ncaRegime: "NON_NCA" }) }))
    const res = await decide({ decision: "APPROVE", note: "Checked" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ override: { status: "REJECTED", decisionNote: "stale: the application changed since the request" } })
    expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith({
      where: { id: "ov-1" },
      data: expect.objectContaining({ status: "REJECTED", decidedById: "admin-b", decisionNote: "stale: the application changed since the request" }),
    })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECIDED",
      newValue: expect.objectContaining({ status: "REJECTED", stale: true, requestedDecision: "APPROVE", ncaRegime: "NON_NCA" }),
    }), m.tx)
  })

  it.each([
    ["borrower", { entityId: "ent-2" }],
    ["amount", { appliedAmount: 140_000_000 }],
    ["product", { productId: "prod-2" }],
    ["classification rule", { ncaClassificationRule: "LARGE_AGREEMENT" }],
  ])("APPROVE after the application's %s changed since the request rejects it as stale: 409, regime untouched", async (_label, change) => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ application: app(change) }))
    const res = await decide({ decision: "APPROVE", note: "Checked" })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ override: { status: "REJECTED", decisionNote: "stale: the application changed since the request" } })
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("REJECT on a stale request records the rejection with the decider's note", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ application: app({ status: "UNDER_REVIEW", ncaRegime: "NON_NCA" }) }))
    const res = await decide({ decision: "REJECT", note: "No longer relevant" })
    expect(res.status).toBe(200)
    expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "REJECTED", decisionNote: "No longer relevant" }),
    }))
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("answers 409 to APPROVE once the application is decided, writing nothing", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ application: app({ status: "APPROVED", ncaRegime: "NCA" }) }))
    expect((await decide({ decision: "APPROVE", note: "Checked" })).status).toBe(409)
    expect(m.tx.ncaRegimeOverride.update).not.toHaveBeenCalled()
  })

  it("still accepts REJECT once the application is decided", async () => {
    m.tx.ncaRegimeOverride.findFirst.mockResolvedValue(pending({ application: app({ status: "APPROVED", ncaRegime: "NCA" }) }))
    expect((await decide({ decision: "REJECT", note: "Application decided" })).status).toBe(200)
    expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "REJECTED" }),
    }))
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
  })

  it("answers 409 when the database refuses the decision (SQLSTATE 23514), not 500", async () => {
    m.transactionError.current = Object.assign(new Error("A change to NON_NCA requires an approved NcaRegimeOverride"), { code: "23514" })
    expect((await decide({ decision: "APPROVE", note: "Checked" })).status).toBe(409)
  })

  it("approves: locks, records the decision, moves the regime and audits in the transaction", async () => {
    const res = await decide({ decision: "APPROVE", note: "  AFS checked against CIPC  " })
    expect(res.status).toBe(200)
    expect(m.tx.$queryRaw).toHaveBeenCalledTimes(2) // application, then override, FOR UPDATE
    expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith({
      where: { id: "ov-1" },
      data: expect.objectContaining({ status: "APPROVED", decidedById: "admin-b", decisionNote: "AFS checked against CIPC", decidedAt: expect.any(Date) }),
    })
    expect(m.tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" },
      data: { ncaRegime: "NON_NCA" },
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECIDED", entityId: "ov-1", userId: "admin-b",
      newValue: expect.objectContaining({ status: "APPROVED", ncaRegime: "NON_NCA", requestedById: "admin-a" }),
    }), m.tx)
    expect(m.auditRefusal).not.toHaveBeenCalled()
  })

  it("rejects: records the decision and leaves the regime alone", async () => {
    const res = await decide({ decision: "REJECT", note: "Turnover is the group's" })
    expect(res.status).toBe(200)
    expect(m.tx.ncaRegimeOverride.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "REJECTED", decidedById: "admin-b" }),
    }))
    expect(m.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "NCA_OVERRIDE_DECIDED", newValue: expect.objectContaining({ status: "REJECTED", ncaRegime: "NCA" }),
    }), m.tx)
  })
})
