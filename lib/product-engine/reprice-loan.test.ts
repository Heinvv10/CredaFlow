import { beforeEach, describe, expect, it, vi } from "vitest"

const { logAuditStrict } = vi.hoisted(() => ({ logAuditStrict: vi.fn(async () => undefined) }))
vi.mock("@/lib/audit", () => ({ logAuditStrict, AuditAction: { LOAN_RATE_REPRICED: "LOAN_RATE_REPRICED" } }))

import { repriceLoan } from "./reprice-loan"
import { generateSchedule } from "./schedule"
import type { RepaymentTerms } from "./types"

const terms: RepaymentTerms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 }
const start = new Date("2027-01-10T08:00:00+02:00")
const rows = generateSchedule({ principalCents: 1_200_000, interestRatePm: 0.01, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate: start, terms }).schedule.map((r, i) => ({
  id: `r${i + 1}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: 0, creditLifePremiumDue: 0, totalDue: r.totalDue, totalPaid: 0, status: "PENDING", commonLawContractualInterestDue: null,
}))
const last = {
  sequence: 1, productVersionId: "v1", frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12, balloonCents: 0, pricingRuleId: null as string | null, pricingRuleName: null as string | null, pricingInputs: null,
  baseRatePm: 0.01, interestRatePm: 0.01, rateBasis: "PRIME", rateMarginPa: 0.03, referenceRate: 0.09, referenceEffectiveDate: new Date("2026-06-01T00:00:00Z"),
}
function tx(over: { status?: string; last?: Record<string, unknown>; written?: number; contractual?: boolean } = {}) {
  return {
    $queryRaw: vi.fn(async () => []),
    loan: {
      findFirst: vi.fn(async () => ({ status: over.status ?? "ACTIVE", startDate: start, contractualTotalInterest: over.contractual === false ? null : 100, contractualTotalRepayable: over.contractual === false ? null : 200, terms: [{ ...last, ...over.last }], repaymentSchedule: rows })),
      update: vi.fn(async () => ({})),
    },
    loanTerms: { create: vi.fn(async () => ({ id: "t2" })) },
    repaymentSchedule: { updateMany: vi.fn(async () => ({ count: over.written ?? 1 })) },
  }
}
const run = (db: ReturnType<typeof tx>, reference = { rate: 0.11, effectiveDate: "2027-04-01" }, basis: "PRIME" | "LENDER_BASE" = "PRIME") =>
  repriceLoan(db as never, { tenantId: "t", loanId: "l", basis, reference, today: "2027-04-01" })

beforeEach(() => vi.clearAllMocks())

describe("repriceLoan", () => {
  it("pins every row it rewrites to untouched, in this tenant and loan", async () => {
    const db = tx()
    expect(await run(db)).toMatchObject({ kind: "repriced", sequence: 2 })
    for (const [call] of db.repaymentSchedule.updateMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>) expect(call.where).toMatchObject({ tenantId: "t", loanId: "l", status: "PENDING", totalPaid: 0 })
  })

  it("throws, so the transaction rolls back, when a row moved under it", async () => {
    await expect(run(tx({ written: 0 }))).rejects.toThrow("changed under the loan lock")
  })

  it("moves both agreed totals by the change in interest, and leaves them alone when the loan has none", async () => {
    const db = tx()
    await run(db)
    const data = (db.loan.update.mock.calls as unknown as Array<[{ data: Record<string, { increment: number }> }]>)[0]![0].data
    expect(data.contractualTotalInterest!.increment).toBe(data.totalInterest!.increment)
    expect(data.contractualTotalRepayable!.increment).toBe(data.totalInterest!.increment)
    const none = tx({ contractual: false })
    await run(none)
    expect((none.loan.update.mock.calls as unknown as Array<[{ data: object }]>)[0]![0].data).not.toHaveProperty("contractualTotalRepayable")
  })

  it("writes nothing for a loan not active, not variable, or on another basis", async () => {
    for (const [db, reason] of [[tx({ status: "COMPLETED" }), "not_active"], [tx({ last: { rateBasis: null } }), "not_variable"], [tx({ last: { rateBasis: "LENDER_BASE" } }), "other_basis"]] as const) {
      expect(await run(db)).toEqual({ kind: "not_eligible", reason })
      expect(db.loanTerms.create).not.toHaveBeenCalled()
      expect(db.repaymentSchedule.updateMany).not.toHaveBeenCalled()
    }
  })

  it("writes nothing when the value leaves the rate where it is, or the loan is on that day or a later one", async () => {
    const same = tx({ last: { interestRatePm: 0.01166667 } })
    expect(await run(same)).toEqual({ kind: "unchanged" })
    expect(same.loanTerms.create).not.toHaveBeenCalled()
    expect(await run(tx(), { rate: 0.11, effectiveDate: "2026-06-01" })).toEqual({ kind: "already_repriced" })
  })

  it("moves the base with the rate when a rule priced the loan, so the rule's discount stays inside the margin", async () => {
    const db = tx({ last: { pricingRuleId: "r1", pricingRuleName: "Staff", baseRatePm: 0.012 } })
    await run(db)
    const data = (db.loanTerms.create.mock.calls as unknown as Array<[{ data: { baseRatePm: number; interestRatePm: number } }]>)[0]![0].data
    expect(data.interestRatePm).toBe(0.01166667)
    expect(data.baseRatePm).toBeCloseTo(0.012 + 0.00166667, 8)
  })
})
