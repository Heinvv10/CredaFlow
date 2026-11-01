import { beforeEach, describe, expect, it, vi } from "vitest"

const compute = vi.hoisted(() => ({ result: null as unknown }))
vi.mock("./compute", async (original) => ({ ...(await original<typeof import("./compute")>()), computeChange: async () => compute.result, inArrears: () => false }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => key }), logAuditStrict: vi.fn(async () => undefined) }))

import { applyLoanChange } from "./apply"
import type { LoanChangePayload } from "./types"

function recordingTx() {
  const calls: string[] = []
  const writes: Array<{ call: string; data: Record<string, unknown> }> = []
  const model = (name: string) => new Proxy({}, { get: (_t, method) => async (args: { data?: Record<string, unknown> }) => { calls.push(`${name}.${String(method)}`); writes.push({ call: `${name}.${String(method)}`, data: args?.data ?? {} }); return { id: "x" } } })
  const tx = new Proxy({}, {
    get: (_t, key) => {
      if (key === "$queryRaw") return async (_s: TemplateStringsArray, id: string) => { calls.push(`lock ${id}`); return [] }
      if (key === "$executeRawUnsafe") return async (sql: string) => { calls.push(sql); return 0 }
      return model(String(key))
    },
  })
  return { tx: tx as never, calls, writes }
}

const plan = {
  trim: [], remove: [], fresh: [], rows: [], terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 3 },
  interestRatePm: 0.03, totalInterest: 0, totalRepayable: 0, maturityDate: new Date(0), nextPaymentDate: new Date(0), outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, deferredInterest: 0,
}
const loan = { id: "l2", status: "ACTIVE", principal: 1, terms: [{ sequence: 1, productVersionId: null }], repaymentSchedule: [], lastPaymentDate: null }
const ctx = (payload: LoanChangePayload) => ({ tenantId: "t", request: { id: "r", makerId: "m" }, payload, checker: { id: "c", email: "c@test.invalid", role: "ADMIN" }, now: new Date(0) }) as never

describe("applyLoanChange", () => {
  beforeEach(() => { compute.result = { scope: "IN_PLACE", loan, plan } })

  it("locks every loan involved first, in one order, so overlapping consolidations cannot deadlock", async () => {
    const { tx, calls } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "CONSOLIDATION", loanId: "l2", otherLoanIds: ["l3", "l1"], instalments: 6, reason: "reason", signedDocumentId: "d" }))
    expect(calls.slice(0, 3)).toEqual(["lock l1", "lock l2", "lock l3"])
  })

  it("writes the row a receipt part-paid as paid on the last payment's date, or the day of the change", async () => {
    const paidOn = new Date("2026-03-01T10:00:00Z")
    compute.result = { scope: "IN_PLACE", loan: { ...loan, lastPaymentDate: paidOn }, plan: { ...plan, trim: [{ id: "t1", principalDue: 5, interestDue: 0, feesDue: 0, totalDue: 5, totalPaid: 5 }] } }
    const { tx, writes } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "RATE_CHANGE", loanId: "l2", interestRatePm: 0.03, reason: "reason", signedDocumentId: "d" }))
    expect(writes.find((w) => w.call === "repaymentSchedule.update")?.data).toMatchObject({ status: "PAID", paidAt: paidOn })
  })

  it("appends terms that keep the loan's version and record what a holiday deferred", async () => {
    compute.result = { scope: "IN_PLACE", loan: { ...loan, terms: [{ sequence: 3, productVersionId: "pv" }] }, plan: { ...plan, deferredInterest: 700 } }
    const { tx, writes } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "PAYMENT_HOLIDAY", loanId: "l2", holidayInstalments: 1, reason: "reason", signedDocumentId: "d" }))
    expect(writes.find((w) => w.call === "loanTerms.create")?.data).toMatchObject({ sequence: 4, productVersionId: "pv", deferredInterest: 700, changeRequestId: "r" })
  })

  it("restates the contract the loan now stands on", async () => {
    compute.result = { scope: "IN_PLACE", loan, plan: { ...plan, totalInterest: 11, totalRepayable: 111, maturityDate: new Date(5) } }
    const { tx, writes } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "RATE_CHANGE", loanId: "l2", interestRatePm: 0.03, reason: "reason", signedDocumentId: "d" }))
    expect(writes.find((w) => w.call === "loan.update")?.data).toMatchObject({ totalInterest: 11, totalRepayable: 111, contractualTotalInterest: 11, contractualTotalRepayable: 111, maturityDate: new Date(5) })
  })

  it("marks a loan in default when it is restructured, so IFRS 9 holds it in Stage 3", async () => {
    compute.result = { scope: "IN_PLACE", loan: { ...loan, status: "DEFAULTED" }, plan }
    const { tx, writes } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "RESCHEDULE", loanId: "l2", firstDueDate: "2026-01-01", reason: "reason", signedDocumentId: "d" }))
    expect(writes.find((w) => w.call === "loan.update")?.data).toMatchObject({ restructuredAt: new Date(0), defaultedAtRestructure: true, status: "ACTIVE" })
  })

  it("runs the deferred reconciliation inside the approval, last, while it can still roll back", async () => {
    const { tx, calls } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "RATE_CHANGE", loanId: "l2", interestRatePm: 0.03, reason: "reason", signedDocumentId: "d" }))
    expect(calls.at(-1)).toBe("SET CONSTRAINTS ALL IMMEDIATE")
  })
})
