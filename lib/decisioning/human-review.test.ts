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

beforeEach(() => { h.app = { id: "a", status: "DECLINED", clientId: "c" }; h.run = { id: "r1" }; h.count = 1; h.records = []; h.audits = [] })

describe("requestHumanReview", () => {
  it("reopens an automatically declined application to UNDER_REVIEW, audited, with the decision log saying who reopened it and why", async () => {
    await requestHumanReview(input)
    const update = h.records.find((r) => (r as unknown[])[0] === "update") as [string, { where: Record<string, unknown>; data: Record<string, unknown> }]
    expect(update[1].where).toMatchObject({ id: "a", tenantId: "t", status: "DECLINED" })
    expect(update[1].data).toMatchObject({ status: "UNDER_REVIEW", approvedById: null, approvedAt: null, decisionReason: null, declineCategory: null })
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
    h.app = { id: "a", status: "APPROVED", clientId: "c" }
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
})
