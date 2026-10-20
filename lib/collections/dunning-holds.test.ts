import { describe, expect, it } from "vitest"
import { HELD_COLLECTIONS_STAGES, notHeldLoanWhere, remindableLoanWhere } from "./dunning-holds"

describe("remindableLoanWhere", () => {
  const where = remindableLoanWhere()

  it("only reminds ACTIVE loans", () => {
    expect(where.status).toBe("ACTIVE")
    expect(notHeldLoanWhere().status).toBeUndefined()
  })

  it("holds an attorney referral and a write-off, but NOT the arrangement stage on its own (it never moves back)", () => {
    expect([...HELD_COLLECTIONS_STAGES].sort()).toEqual(["ATTORNEY_REFERRED", "WRITTEN_OFF"])
    expect(where.collectionsStage).toEqual({ notIn: ["ATTORNEY_REFERRED", "WRITTEN_OFF"] })
  })

  it("holds a loan under debt review", () => {
    expect(where.debtReviewNoticeAt).toBeNull()
  })

  it("holds an ACTIVE arrangement, not one that is KEPT/BROKEN/COMPLETED", () => {
    expect(where.AND).toContainEqual({ NOT: { paymentArrangement: { is: { status: "ACTIVE" } } } })
  })

  it("holds an active payment plan", () => {
    expect(where.AND).toContainEqual({ NOT: { paymentPlan: { is: { active: true } } } })
  })

  it("holds a deceased client, or a client with a debt-review notice on ANY of their loans, but still selects an entity loan", () => {
    expect(where.AND).toContainEqual({
      OR: [
        { clientId: null },
        { client: { deceasedAt: null, loans: { none: { debtReviewNoticeAt: { not: null } } } } },
      ],
    })
  })

  it("returns a fresh object each call, so a caller cannot mutate the shared rule", () => {
    const a = remindableLoanWhere()
    ;(a as { status: string }).status = "CANCELLED"
    expect(remindableLoanWhere().status).toBe("ACTIVE")
  })
})
