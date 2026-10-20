import { describe, expect, it } from "vitest"
import { HELD_COLLECTIONS_STAGES, remindableLoanWhere } from "./dunning-holds"

describe("remindableLoanWhere", () => {
  const where = remindableLoanWhere()

  it("only reminds ACTIVE loans", () => {
    expect(where.status).toBe("ACTIVE")
  })

  it("holds the three stages where a person or a process owns the account", () => {
    expect([...HELD_COLLECTIONS_STAGES].sort()).toEqual(["ATTORNEY_REFERRED", "PAYMENT_ARRANGEMENT", "WRITTEN_OFF"])
    expect(where.collectionsStage).toEqual({ notIn: HELD_COLLECTIONS_STAGES })
  })

  it("holds a loan under debt review", () => {
    expect(where.debtReviewNoticeAt).toBeNull()
  })

  it("holds a loan with an ACTIVE payment arrangement, not one that is KEPT/BROKEN/COMPLETED", () => {
    expect(where.AND).toContainEqual({ NOT: { paymentArrangement: { is: { status: "ACTIVE" } } } })
  })

  it("holds a deceased borrower but still selects an entity loan, which has no client", () => {
    expect(where.AND).toContainEqual({ OR: [{ clientId: null }, { client: { deceasedAt: null } }] })
  })

  it("returns a fresh object each call, so a caller cannot mutate the shared rule", () => {
    const a = remindableLoanWhere()
    ;(a as { status: string }).status = "CANCELLED"
    expect(remindableLoanWhere().status).toBe("ACTIVE")
  })
})
