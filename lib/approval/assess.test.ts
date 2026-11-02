import { describe, expect, it, vi } from "vitest"
vi.mock("@/lib/security/account-control", () => ({ accountControlRefusal: vi.fn(async () => null) }))
import { assessApproval } from "./assess"
import type { StoredMatrix } from "./matrix-store"

const levels = [{ level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: true }]
const matrix = { id: "m", version: 1, payload: { name: "M", enabled: true, effectiveFrom: "2026-01-01", levels, rules: [], defaultRequiredLevels: 1 } } as unknown as StoredMatrix

describe("assessApproval", () => {
  it("names the tenant on every read: the application page runs with no tenant frame, and the scope extension refuses a read that does not", async () => {
    const steps = vi.fn(async (_args: { where: Record<string, unknown> }) => [])
    const decisions = vi.fn(async (_args: { where: Record<string, unknown> }) => [])
    const db = {
      approvalStep: { findMany: steps }, creditCommitteeDecision: { findMany: decisions }, approvalDelegation: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) }, auditLog: {},
    }
    await assessApproval(db as never, {
      tenantId: "t1", matrix, theCase: { id: "c1", requiredLevels: 1, matchedRuleIds: [], levelsSnapshot: levels }, inputStaffIds: [],
      facts: { amountCents: 1, productId: "p", branchId: null, riskGradeRank: null }, user: { id: "u", role: "LOAN_ADMIN" }, automated: false, now: new Date("2026-11-01T10:00:00Z"),
    })
    expect(steps.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" })
    expect(decisions.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" })
  })
})
