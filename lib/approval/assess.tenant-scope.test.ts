import { describe, expect, it, vi } from "vitest"
import { assessApproval } from "./assess"

// A server page has no tenant frame: every read here carries its tenant, or the page answers 500 under a matrix.
describe("assessApproval on a page with no tenant frame", () => {
  it("names the tenant on the reads of a case", async () => {
    const steps = vi.fn(async () => [])
    const committee = vi.fn(async () => [])
    const db = {
      approvalStep: { findMany: steps }, creditCommitteeDecision: { findMany: committee }, approvalDelegation: { findMany: vi.fn(async () => []) },
      user: { findMany: vi.fn(async () => []) }, approvalMatrixVersion: { findFirst: vi.fn(async () => null) },
    }
    const levels = [{ level: 1, name: "One", role: "LOAN_ADMIN", slaHours: 24, committee: true }]
    await assessApproval(db as never, {
      tenantId: "t1",
      matrix: { id: "m1", version: 1, payload: { name: "m", enabled: true, effectiveFrom: "2026-01-01", levels, rules: [], defaultRequiredLevels: 1 } } as never,
      theCase: { id: "case-1", requiredLevels: 1, levelsSnapshot: levels, matchedRuleIds: [] } as never,
      facts: { amountCents: 1, productId: "p", branchId: null, riskGradeRank: null }, inputStaffIds: [], user: { id: "u1", role: "LOAN_ADMIN" }, automated: false, now: new Date(),
    }).catch(() => undefined)
    expect((steps.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { tenantId: "t1", caseId: "case-1" } })
    expect((committee.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { tenantId: "t1", caseId: "case-1" } })
  })
})
