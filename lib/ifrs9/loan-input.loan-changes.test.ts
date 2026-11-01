import { describe, expect, it } from "vitest"
import { inheritPriorStaging, loadRunLoans } from "./loan-input"
import type { PriorStaging } from "./staging"

const prior = (stage: 1 | 2 | 3): PriorStaging => ({ stage, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-01-31" })
const changes = (rows: Array<{ newLoanId: string; sourceLoanIds: string[] }>) => ({ loanChange: { findMany: async () => rows } }) as never

describe("inheritPriorStaging", () => {
  it("takes the worst stage of the loans replaced, whichever comes first", async () => {
    for (const sourceLoanIds of [["a", "b"], ["b", "a"]]) {
      const priors = new Map([["a", prior(2)], ["b", prior(3)]])
      await inheritPriorStaging(changes([{ newLoanId: "n", sourceLoanIds }]), "t", priors)
      expect(priors.get("n")?.stage).toBe(3)
    }
  })

  it("asks for the changes oldest first, so a loan replaced twice inherits through the one between", async () => {
    let orderBy: unknown
    const db = { loanChange: { findMany: async (args: { orderBy: unknown }) => { orderBy = args.orderBy; return [] } } } as never
    await inheritPriorStaging(db, "t", new Map())
    expect(orderBy).toEqual({ appliedAt: "asc" })
  })

  it("keeps a stage the loan already has of its own", async () => {
    const priors = new Map([["a", prior(3)], ["n", prior(1)]])
    await inheritPriorStaging(changes([{ newLoanId: "n", sourceLoanIds: ["a"] }]), "t", priors)
    expect(priors.get("n")?.stage).toBe(1)
  })
})

describe("loadRunLoans", () => {
  it("reads the terms in force, the latest row, not the origination", async () => {
    const seq = [
      { sequence: 1, frequency: "MONTHLY", graceKind: "FULL", graceInstalments: 2, deferredInterest: 500 },
      { sequence: 2, frequency: "MONTHLY", graceKind: "NONE", graceInstalments: 0, deferredInterest: 0 },
    ]
    const row = (terms: unknown[]) => ({ id: "l", reference: "L", productId: "p", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", debtReviewNoticeAt: null, startDate: new Date(0), principal: 1, outstandingPrincipal: 1, chargesOutstanding: 0, restructuredAt: null, ifrs9Flags: [], terms, repaymentSchedule: [] })
    const db = { loan: { findMany: async (args: { select: { terms: { orderBy: { sequence: "asc" | "desc" }; take: number } } }) => {
      const { orderBy, take } = args.select.terms
      const sorted = [...seq].sort((a, b) => (orderBy.sequence === "asc" ? a.sequence - b.sequence : b.sequence - a.sequence))
      return [row(sorted.slice(0, take))]
    } } } as never
    const [loan] = await loadRunLoans(db, "t", new Date(), null)
    expect(loan!.graceDeferral).toBeUndefined()
  })

  it("a full grace still reads through when the origination is the only row", async () => {
    const terms = [{ sequence: 1, frequency: "MONTHLY", graceKind: "FULL", graceInstalments: 2, deferredInterest: 500 }]
    const db = { loan: { findMany: async () => [{ id: "l", reference: "L", productId: "p", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", debtReviewNoticeAt: null, startDate: new Date(0), principal: 1, outstandingPrincipal: 1, chargesOutstanding: 0, restructuredAt: null, ifrs9Flags: [], terms, repaymentSchedule: [] }] } } as never
    const [loan] = await loadRunLoans(db, "t", new Date(), null)
    expect(loan!.graceDeferral?.cents).toBe(500)
  })
})
