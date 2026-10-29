import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ app: null as unknown, run: null as unknown, count: 1, records: [] as unknown[], audits: [] as unknown[] }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn({
      loanApplication: { findFirst: async () => h.app, updateMany: vi.fn(async (a: unknown) => { h.records.push(["update", a]); return { count: h.count } }) },
      autoDecisionRun: { findFirst: async () => h.run },
      auditLog: { create: async (a: unknown) => { h.audits.push(a) } },
      creditDecisionRecord: { create: async (a: unknown) => { h.records.push(["record", a]) } },
    }),
  },
}))

import { requestHumanReview } from "./human-review"

const actor = { id: "u1", email: "u@x.invalid", role: "LOAN_ADMIN" }
const input = { tenantId: "t", applicationId: "a", actor, reason: "Client asked for a person to review the decision" }

const systemDeclined = { id: "a", status: "DECLINED", clientId: "c", approvedById: "sys", approvedBy: { isSystem: true }, humanReviewRequestedAt: null, affordabilityResult: { schemaVersion: 3, assessment: { stage: "ASSESSMENT" } } }
beforeEach(() => { h.app = systemDeclined; h.run = { id: "r1", createdAt: new Date("2026-10-29T08:00:00Z") }; h.count = 1; h.records = []; h.audits = [] })

describe("requestHumanReview", () => {
  it("reopens an automatically declined application to UNDER_REVIEW, audited, with the decision log saying who reopened it and why", async () => {
    await requestHumanReview(input)
    const update = h.records.find((r) => (r as unknown[])[0] === "update") as [string, { where: Record<string, unknown>; data: Record<string, unknown> }]
    expect(update[1].where).toMatchObject({ id: "a", tenantId: "t", status: "DECLINED" })
    expect(update[1].data).toMatchObject({ status: "UNDER_REVIEW", approvedById: null, approvedAt: null, decisionReason: null, declineCategory: null })
    // A fresh review cycle, as a return to review has: the old bureau generation and the reckless-lending attestation do not carry over.
    expect(update[1].data).toMatchObject({ recklessLendingAssessed: false, recklessLendingAssessedById: null, recklessLendingAssessedAt: null, humanReviewRequestedAt: expect.any(Date) })
    expect(typeof (update[1].data as { bureauReviewGeneration: unknown }).bureauReviewGeneration).toBe("string")
    // And what the decline sat on: a bureau override, the approval terms and the approval snapshot, as a return to review clears them.
    expect(update[1].data).toMatchObject({
      bureauOverrideReason: null, bureauOverrideById: null, bureauOverrideAt: null,
      repaymentMethod: null, approvedAmount: null, approvedTermDays: null, approvedRate: null,
      affordabilityResult: expect.objectContaining({ assessment: expect.anything() }),
    })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ data: { action: "AUTO_DECISION_HUMAN_REVIEW_REQUESTED", entityId: "a", userId: "u1" } })
    const record = h.records.find((r) => (r as unknown[])[0] === "record") as [string, { data: Record<string, unknown> }]
    expect(record[1].data).toMatchObject({ decision: "RETURN_TO_REVIEW", actorType: "STAFF", actorUserId: "u1" })
  })

  it("refuses an application a person declined", async () => {
    h.run = null
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_AUTOMATED" })
  })

  it("refuses an application that is not declined", async () => {
    h.app = { ...systemDeclined, status: "APPROVED" }
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_DECLINED" })
  })

  it("refuses a reason that is too short, and an unknown application", async () => {
    await expect(requestHumanReview({ ...input, reason: "short" })).rejects.toMatchObject({ code: "REASON_REQUIRED" })
    h.app = null
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("loses the race cleanly when the status moved first", async () => {
    h.count = 0
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_DECLINED" })
  })

  // Breaker A: history was "engine declined, reopened, then a person declined"; the old engine run must not license reopening it as automated.
  it("refuses when the CURRENT decline is a person's, even though the engine declined it earlier", async () => {
    h.app = { ...systemDeclined, approvedById: "u-branch-manager", approvedBy: { isSystem: false } }
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_AUTOMATED" })
    expect(h.records.find((r) => (r as unknown[])[0] === "update")).toBeUndefined()
  })

  it("refuses when the latest automated decline is older than the human review already requested", async () => {
    h.app = { ...systemDeclined, humanReviewRequestedAt: new Date("2026-10-29T09:00:00Z") }
    h.run = { id: "old", createdAt: new Date("2026-10-29T08:00:00Z") }
    await expect(requestHumanReview(input)).rejects.toMatchObject({ code: "NOT_AUTOMATED" })
  })
})
