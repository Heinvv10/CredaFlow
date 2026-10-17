import { describe, expect, it, vi } from "vitest"
import {
  ContractualScheduleMissingError,
  loadSettlementEvidence,
  restoreContractualSchedule,
} from "./contractual-schedule"

const contract = (id: string, installmentNo: number) => ({
  id, installmentNo, principalDue: 100_000, interestDue: 5_000, feesDue: 6_900, creditLifePremiumDue: 0, totalDue: 111_900,
})
const repriced = (id: string, installmentNo: number) => ({
  id, installmentNo, dueDate: new Date("2026-08-01"), principalDue: 100_000, interestDue: 0, feesDue: 0,
  creditLifePremiumDue: 0, totalDue: 100_000, totalPaid: 100_000,
})
const loan = {
  id: "loan-1", principal: 200_000, totalInterest: 0, totalRepayable: 200_000, totalPaid: 200_000, interestRatePm: 0.05,
  interestModel: "FLAT" as const, startDate: new Date("2026-06-01"), maturityDate: new Date("2026-08-01"),
}

describe("restoreContractualSchedule", () => {
  it("puts each instalment's contractual money back by instalment number", () => {
    const rows = restoreContractualSchedule({
      loan, schedule: [repriced("r1", 1), repriced("r2", 2)], contractualRows: [contract("r2", 2), contract("r1", 1)],
    })
    expect(rows.map((row) => [row.id, row.totalDue])).toEqual([["r1", 111_900], ["r2", 111_900]])
  })

  it("refuses recorded rows that do not fit the schedule", () => {
    const schedule = [repriced("r1", 1), repriced("r2", 2)]
    for (const contractualRows of [[contract("r1", 1)], [contract("r1", 1), contract("other", 2)], [contract("r1", 2), contract("r2", 1)]]) {
      expect(() => restoreContractualSchedule({ loan, schedule, contractualRows })).toThrow(ContractualScheduleMissingError)
    }
  })
})

describe("loadSettlementEvidence", () => {
  const audit = (over: Record<string, unknown> = {}, value: Record<string, unknown> = {}) => ({
    action: "PAYMENT_RECORDED", entity: "Loan", entityId: "loan-1",
    newValue: { earlyInstalmentSettlement: true, loanId: "loan-1", paymentId: "pay-1", settlementDue: 200_000,
      contractualRows: [contract("r1", 1), contract("r2", 2)], ...value },
    ...over,
  })
  const payment = { id: "pay-1", loanId: "loan-1", amount: 200_000, reversed: false, allocationStatus: "ALLOCATED" }
  const db = (audits: unknown[], payments: unknown[] = [payment], deposits: unknown[] = []) => ({
    auditLog: { findMany: vi.fn(async () => audits) },
    payment: { findMany: vi.fn(async () => payments) },
    bankTransaction: { findMany: vi.fn(async () => deposits) },
    repaymentSchedule: { findMany: vi.fn(async () => [
      { id: "r1", loanId: "loan-1", installmentNo: 1 }, { id: "r2", loanId: "loan-1", installmentNo: 2 },
    ]) },
  })
  const found = async (...args: Parameters<typeof db>) =>
    (await loadSettlementEvidence(db(...args) as never, "t1", ["loan-1"])).get("loan-1")?.paymentId ?? null

  it("reads the settlement a receipt writer recorded", async () => {
    expect(await found([audit()])).toBe("pay-1")
    expect(await found([audit({ action: "PAYMENT_ALLOCATED", entity: "Payment", entityId: "pay-1" })])).toBe("pay-1")
    expect(await found([audit({ action: "BANK_TXN_RECONCILED", entity: "BankTransaction", entityId: "txn-1" })], [payment], [{ id: "txn-1", paymentId: "pay-1" }]))
      .toBe("pay-1")
  })

  it("asks only for receipt writers' audit rows", async () => {
    const reader = db([])
    await loadSettlementEvidence(reader as never, "t1", ["loan-1"])
    expect(reader.auditLog.findMany.mock.calls[0]).toEqual([expect.objectContaining({
      where: expect.objectContaining({ action: { in: ["PAYMENT_RECORDED", "SMALL_BALANCE_WAIVED", "PAYMENT_ALLOCATED", "BANK_TXN_RECONCILED"] } }),
    })])
  })

  it("ignores evidence that does not name this loan's live settlement receipt", async () => {
    expect(await found([audit({ entityId: "loan-2" })])).toBeNull()
    expect(await found([audit({ action: "PAYMENT_ALLOCATED", entity: "Payment", entityId: "pay-2" })])).toBeNull()
    expect(await found([audit({ action: "BANK_TXN_RECONCILED", entity: "BankTransaction", entityId: "txn-1" })], [payment], [{ id: "txn-1", paymentId: "pay-9" }]))
      .toBeNull()
    expect(await found([audit()], [{ ...payment, reversed: true }])).toBeNull()
    expect(await found([audit()], [{ ...payment, loanId: "loan-2" }])).toBeNull()
    expect(await found([audit({}, { settlementDue: 199_999 })])).toBeNull()
    expect(await found([audit({}, { contractualRows: [contract("r1", 1), contract("foreign", 2)] })])).toBeNull()
    expect(await found([audit({}, { contractualRows: [contract("r1", 1)] })])).toBeNull()
  })

  it("accepts the receipt being reversed in this transaction", async () => {
    const evidence = await loadSettlementEvidence(db([audit()], [{ ...payment, reversed: true }]) as never, "t1", ["loan-1"], "pay-1")
    expect(evidence.get("loan-1")?.paymentId).toBe("pay-1")
  })
})
