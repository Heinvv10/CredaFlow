import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  due: [] as Array<{ id: string; tenantId: string }>,
  claimCount: 1,
  failTransaction: false,
  tx: {
    approvalCase: { findFirst: vi.fn(), updateMany: vi.fn() },
    loanApplication: { findFirst: vi.fn() },
    approvalStep: { findMany: vi.fn() },
    approvalEscalation: { create: vi.fn() },
    notification: { createMany: vi.fn() },
    user: { findMany: vi.fn() },
    approvalDelegation: { findMany: vi.fn() },
  },
  postponed: vi.fn(),
  audit: vi.fn(),
  logged: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    approvalCase: { findMany: vi.fn(async () => h.due), updateMany: (args: unknown) => h.postponed(args) },
    $transaction: async (fn: (tx: typeof h.tx) => Promise<unknown>) => {
      if (h.failTransaction) throw new Error("database down")
      return fn(h.tx)
    },
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAuditStrict: h.audit }))
vi.mock("@/lib/observability/logger", () => ({ logger: { error: h.logged, warn: vi.fn(), info: vi.fn() } }))

import { escalateOverdueApprovals, escalationTarget } from "./escalation"

const now = new Date("2026-11-02T10:00:00Z")
const overdueCase = {
  id: "c1", applicationId: "a1", status: "OPEN", dueAt: new Date("2026-11-02T08:00:00Z"), pendingLevel: 1, escalationCount: 0, matrixVersionId: null,
  levelsSnapshot: [
    { level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
  ],
}

beforeEach(() => {
  h.due = [{ id: "c1", tenantId: "t1" }]
  h.claimCount = 1
  h.failTransaction = false
  for (const model of Object.values(h.tx)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset()
  h.tx.approvalCase.findFirst.mockResolvedValue(overdueCase)
  h.tx.approvalCase.updateMany.mockImplementation(async () => ({ count: h.claimCount }))
  h.tx.loanApplication.findFirst.mockResolvedValue({ reference: "APP-1", appliedAmount: 500_000, inputStaffIds: [] })
  h.tx.approvalStep.findMany.mockResolvedValue([])
  h.tx.user.findMany.mockResolvedValue([{ id: "bm1", role: "BRANCH_MANAGER" }])
  h.tx.approvalDelegation.findMany.mockResolvedValue([])
  h.postponed.mockReset().mockResolvedValue({ count: 1 })
  h.audit.mockReset()
  h.logged.mockReset()
})

describe("escalationTarget", () => {
  it("climbs one level per escalation from the pending level, and stops at the top", () => {
    expect(escalationTarget(1, 0, 3)).toBe(2)
    expect(escalationTarget(1, 1, 3)).toBe(3)
    expect(escalationTarget(1, 5, 3)).toBe(3)
    expect(escalationTarget(2, 0, 3)).toBe(3)
    expect(escalationTarget(3, 0, 3)).toBe(3)
  })
})

describe("escalateOverdueApprovals", () => {
  it("escalates an overdue case once: the escalation is recorded, the level's people are told and the audit trail written", async () => {
    expect(await escalateOverdueApprovals({ now })).toEqual({ escalated: 1, reminded: 0, failed: 0 })
    expect(h.tx.approvalEscalation.create).toHaveBeenCalledWith({ data: expect.objectContaining({ caseId: "c1", fromLevel: 1, toLevel: 2, notifiedUserIds: ["bm1"] }) })
    expect(h.tx.notification.createMany).toHaveBeenCalledTimes(1)
    expect(h.audit).toHaveBeenCalledTimes(1)
  })

  it("does nothing when another replica claimed the case first (the claim is by the due time that was read)", async () => {
    h.claimCount = 0
    expect(await escalateOverdueApprovals({ now })).toEqual({ escalated: 0, reminded: 0, failed: 0 })
    expect(h.tx.approvalCase.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", status: "OPEN", dueAt: overdueCase.dueAt } }))
    expect(h.tx.approvalEscalation.create).not.toHaveBeenCalled()
    expect(h.tx.notification.createMany).not.toHaveBeenCalled()
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("a failing case is counted, logged and pushed back an hour so it cannot starve the cases behind it", async () => {
    h.failTransaction = true
    expect(await escalateOverdueApprovals({ now })).toEqual({ escalated: 0, reminded: 0, failed: 1 })
    expect(h.logged).toHaveBeenCalledWith("approval: escalation failed for case", expect.objectContaining({ caseId: "c1" }))
    expect(h.postponed).toHaveBeenCalledWith({ where: { id: "c1", status: "OPEN", dueAt: { lt: now } }, data: { dueAt: new Date(now.getTime() + 3_600_000) } })
  })
})
