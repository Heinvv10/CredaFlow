import { beforeEach, describe, expect, it, vi } from "vitest"

const compute = vi.hoisted(() => ({ result: null as unknown }))
vi.mock("./compute", async (original) => ({ ...(await original<typeof import("./compute")>()), computeChange: async () => compute.result, inArrears: () => false }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, key) => key }), logAuditStrict: vi.fn(async () => undefined) }))

import { applyLoanChange } from "./apply"
import type { LoanChangePayload } from "./types"

function recordingTx() {
  const calls: string[] = []
  const model = (name: string) => new Proxy({}, { get: (_t, method) => async () => { calls.push(`${name}.${String(method)}`); return { id: "x" } } })
  const tx = new Proxy({}, {
    get: (_t, key) => {
      if (key === "$queryRaw") return async (_s: TemplateStringsArray, id: string) => { calls.push(`lock ${id}`); return [] }
      if (key === "$executeRawUnsafe") return async (sql: string) => { calls.push(sql); return 0 }
      return model(String(key))
    },
  })
  return { tx: tx as never, calls }
}

const plan = {
  trim: [], remove: [], fresh: [], rows: [], terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 3 },
  interestRatePm: 0.03, totalInterest: 0, totalRepayable: 0, maturityDate: new Date(0), nextPaymentDate: new Date(0), outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, deferredInterest: 0,
}
const loan = { id: "l2", status: "ACTIVE", terms: [{ sequence: 1, productVersionId: null }], repaymentSchedule: [], lastPaymentDate: null }
const ctx = (payload: LoanChangePayload) => ({ tenantId: "t", request: { id: "r", makerId: "m" }, payload, checker: { id: "c", email: "c@test.invalid", role: "ADMIN" }, now: new Date(0) }) as never

describe("applyLoanChange", () => {
  beforeEach(() => { compute.result = { scope: "IN_PLACE", loan, plan } })

  it("locks every loan involved first, in one order, so overlapping consolidations cannot deadlock", async () => {
    const { tx, calls } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "CONSOLIDATION", loanId: "l2", otherLoanIds: ["l3", "l1"], instalments: 6, reason: "reason", signedDocumentId: "d" }))
    expect(calls.slice(0, 3)).toEqual(["lock l1", "lock l2", "lock l3"])
  })

  it("runs the deferred reconciliation inside the approval, last, while it can still roll back", async () => {
    const { tx, calls } = recordingTx()
    await applyLoanChange(tx, ctx({ type: "RATE_CHANGE", loanId: "l2", interestRatePm: 0.03, reason: "reason", signedDocumentId: "d" }))
    expect(calls.at(-1)).toBe("SET CONSTRAINTS ALL IMMEDIATE")
  })
})
