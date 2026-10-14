// Shared expectations: the solver's rows against the independent oracle, and the
// ledger identities every schedule must satisfy.
import { expect } from "vitest"
import type { ScheduleRow, StructureInput, StructureResult } from "../types"
import {
  oracleDealFromInput,
  oracleFromBase,
  oracleRealBase,
  oracleReplay,
  type OracleDeal,
} from "./structure-oracle"

const regularPayment = (row: ScheduleRow): number => row.totalCents - row.balloonCents

/** Rows (a full schedule, or a repriced tail) agree with the oracle to the cent. */
export function expectRowsMatchOracle(deal: OracleDeal, rows: ScheduleRow[], baseCents: number): void {
  expect(rows.map((r) => r.dueDate)).toEqual(deal.dueDates)
  // B is the real-valued solution rounded to the cent: within half a cent of
  // the oracle's bisection result.
  expect(Math.abs(baseCents - oracleRealBase(deal))).toBeLessThanOrEqual(0.5 + 1e-6)

  const fromBase = oracleFromBase(deal, baseCents)
  const replay = oracleReplay(deal, rows.map(regularPayment))
  rows.forEach((row, i) => {
    expect({ i, interest: row.interestCents, payment: regularPayment(row) }).toEqual({
      i,
      interest: fromBase[i].interestCents,
      payment: fromBase[i].paymentCents,
    })
    expect(row.interestCents).toBe(replay[i].interestCents)
    expect(row.closingBalanceCents + row.balloonCents).toBe(replay[i].balanceAfterPaymentCents)
  })
  expect(replay[replay.length - 1].balanceAfterPaymentCents).toBe(deal.balloonCents)
}

export function expectMatchesOracle(input: StructureInput, result: StructureResult): void {
  const deal = oracleDealFromInput(input)
  expect(result.financedAmountCents).toBe(deal.openingCents)
  expectRowsMatchOracle(deal, result.rows, result.baseInstalmentCents)
}

/** Row identities for a tail of rows that opens at `openingCents`. */
export function expectRowIdentities(rows: ScheduleRow[], openingCents: number, balloonCents: number): void {
  const last = rows.length - 1
  rows.forEach((row, i) => {
    expect(row.feesCents).toBe(0)
    expect(row.totalCents).toBe(row.principalCents + row.interestCents + row.feesCents + row.balloonCents)
    expect(row.closingBalanceCents).toBe(row.openingBalanceCents + row.interestCents - row.totalCents)
    expect(row.openingBalanceCents).toBe(i === 0 ? openingCents : rows[i - 1].closingBalanceCents)
    expect(row.balloonCents).toBe(i === last ? balloonCents : 0)
  })
  const final = rows[last]
  // The balance after the last REGULAR payment is the balloon; paying the
  // balloon in the same row closes the schedule at zero.
  expect(final.openingBalanceCents + final.interestCents - regularPayment(final)).toBe(balloonCents)
  expect(final.closingBalanceCents).toBe(0)
  const principal = rows.reduce((sum, r) => sum + r.principalCents, 0)
  expect(principal + balloonCents).toBe(openingCents)
}

export function expectLedgerInvariants(result: StructureResult, balloonCents: number): void {
  const { rows } = result
  expectRowIdentities(rows, result.financedAmountCents, balloonCents)
  for (const row of rows) {
    for (const key of ["openingBalanceCents", "interestCents", "principalCents", "totalCents", "closingBalanceCents"] as const) {
      expect(Number.isSafeInteger(row[key])).toBe(true)
    }
    expect(row.interestCents).toBeGreaterThanOrEqual(0)
    expect(row.openingBalanceCents).toBeGreaterThan(0)
    expect(row.totalCents).toBeGreaterThanOrEqual(0)
  }
  expect(Number.isSafeInteger(result.baseInstalmentCents)).toBe(true)
  expect(result.baseInstalmentCents).toBeGreaterThan(0)
  const interest = rows.reduce((sum, r) => sum + r.interestCents, 0)
  const payable = rows.reduce((sum, r) => sum + r.totalCents, 0)
  expect(result.totalInterestCents).toBe(interest)
  expect(result.totalPayableCents).toBe(payable)
  expect(payable).toBe(result.financedAmountCents + interest)
}
