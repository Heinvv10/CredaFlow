/**
 * Review breakers 1b and 1c (PR #255): the dating of a monthly run, and what it starts from.
 */
import { describe, expect, it } from "vitest"
import { loadPriorStaging } from "./loan-input"
import { monthlyInstants } from "./period"
import { assessLoan, type RunContext, type RunLoan } from "./snapshot"
import { DEFAULT_SETTINGS } from "./types"

describe("monthlyInstants (breaker 1b: a make-up run must not stage October on November's days past due)", () => {
  it("describes the month's last day whenever it is made, and rebuilds receipts only once that day is over", () => {
    const onTheDay = monthlyInstants("2026-10", "2026-10-31")
    expect(onTheDay.runDate).toBe("2026-10-31")
    expect(onTheDay.runAt.toISOString()).toBe("2026-10-31T21:59:00.000Z")
    expect(onTheDay.receiptsBefore).toBeNull()

    const madeUp = monthlyInstants("2026-10", "2026-11-03")
    expect(madeUp.runDate).toBe("2026-10-31")
    expect(madeUp.runAt.toISOString()).toBe(onTheDay.runAt.toISOString())
    expect(madeUp.receiptsBefore?.toISOString()).toBe("2026-10-31T22:00:00.000Z")
  })

  it("stages a loan 89 days past due at 31 Oct the same on the 3rd of November as on the 31st", () => {
    const loan: RunLoan = {
      id: "l", reference: "L", productId: "p", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", debtReview: false,
      startDate: new Date("2026-07-03T00:00:00Z"), principal: 100_000, outstandingPrincipal: 100_000, chargesOutstanding: 0, flags: [],
      schedule: [{ dueDate: new Date("2026-08-03T00:00:00Z"), principalDue: 50_000, interestDue: 5_000, feesDue: 0, totalDue: 55_000, totalPaid: 0 },
        { dueDate: new Date("2026-12-03T00:00:00Z"), principalDue: 50_000, interestDue: 5_000, feesDue: 0, totalDue: 55_000, totalPaid: 0 }],
    }
    const ctxFor = (today: string): RunContext => ({
      settings: { ...DEFAULT_SETTINGS, enabled: true }, parameters: [], runAt: monthlyInstants("2026-10", today).runAt, chargesLive: false,
    })
    const month = assessLoan(loan, ctxFor("2026-10-31"), null)
    const makeUp = assessLoan(loan, ctxFor("2026-11-03"), null)
    expect(month).toMatchObject({ dpd: 89, staging: { stage: 2 }, suspended: false })
    expect(makeUp.dpd).toBe(month.dpd)
    expect(makeUp.staging.stage).toBe(month.staging.stage)
  })
})

describe("loadPriorStaging (breaker 1c: an on-demand analysis must not feed the official staging)", () => {
  const sqlOf = async () => {
    let text = ""
    const db = { $queryRaw: async (q: { strings: string[] }) => { text = q.strings.join("?"); return [] } }
    await loadPriorStaging(db as never, "t1", "2026-10-31")
    return text
  }

  it("reads MONTHLY runs only, dated before the run, that no later run supersedes", async () => {
    const text = await sqlOf()
    expect(text).toMatch(/r\."kind" = 'MONTHLY'/)
    expect(text).toMatch(/r\."runDate" < /)
    expect(text).toMatch(/NOT EXISTS[\s\S]*"supersedesRunId" = r\."id"/)
  })
})
