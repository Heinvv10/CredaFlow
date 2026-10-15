/** Shared fixtures for the journal derivation unit tests (synthetic values only). */
import { expect } from "vitest"
import { resolveAccountMap, type AccountMap, type AccountRole, type MappingRow } from "./accounts"
import { accumulate, deriveEntries, type DerivedEntry, type PostedLedger, type VatSettings } from "./derive"
import type { AccountingPeriod } from "./period"
import type { SourceLoan, SourcePayment } from "./source-types"
import { verifyBalanced } from "./verify"

export const at = (iso: string) => new Date(`${iso}T10:00:00+02:00`)

export type TestPayment = Omit<SourcePayment, "parentPaymentId" | "defaultInterestAllocated" | "chargeFeesAllocated">
  & { parentPaymentId?: string | null; defaultInterestAllocated?: number; chargeFeesAllocated?: number }
type TestRow = Omit<SourceLoan["schedule"][number], "totalPaid" | "totalDue"> & { totalPaid?: number; totalDue?: number }
export type TestLoan = Omit<Partial<SourceLoan>, "payments" | "schedule"> & { payments?: TestPayment[]; schedule?: TestRow[] }

export function loan(overrides: TestLoan = {}): SourceLoan {
  const { payments = [], schedule, ...rest } = overrides
  const rows: TestRow[] = schedule ?? [
    { id: "row-1", installmentNo: 1, dueDate: at("2026-09-01"), interestDue: 10_000, feesDue: 6_900, creditLifePremiumDue: 2_000 },
    { id: "row-2", installmentNo: 2, dueDate: at("2026-10-20"), interestDue: 5_000, feesDue: 6_900, creditLifePremiumDue: 2_000 },
  ]
  return {
    id: "loan-1",
    reference: "LN-0001",
    principal: 200_000,
    initiationFee: 10_000,
    upfrontFee: false,
    startDate: at("2026-08-05"),
    status: "ACTIVE",
    writeOffAt: null,
    closedAt: null,
    reversedAt: null,
    charges: [],
    payouts: [],
    recoveries: [],
    ...rest,
    // Principal sits in the instalments: R2,000 on the first, none on later ones.
    schedule: rows.map((r, i) => ({ totalPaid: 0, totalDue: (i === 0 ? 200_000 : 0) + r.interestDue + r.feesDue, ...r })),
    payments: payments.map((p) => ({ parentPaymentId: null, defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...p })),
  }
}

export function ledger() {
  return { posted: new Map() as PostedLedger, keys: new Set<string>() }
}

export function runWith(accounts: AccountMap, vat: VatSettings | null, loans: SourceLoan[], period: AccountingPeriod, state = ledger()) {
  const entries = deriveEntries({ loans, period, posted: state.posted, postedKeys: state.keys, postedLoans: new Map(), accounts, vat })
  const totals = verifyBalanced(entries)
  expect(totals.debitCents).toBe(totals.creditCents)
  accumulate(state.posted, state.keys, entries)
  return entries
}

export const defaultAccounts = (rows: MappingRow[] = []) => resolveAccountMap(rows)

/** Signed per-role totals (+ debit) of some entries, by the role each line posts to. */
export function net(entries: DerivedEntry[]): Partial<Record<AccountRole, number>> {
  const out: Partial<Record<AccountRole, number>> = {}
  for (const e of entries) for (const l of e.lines) out[l.role] = (out[l.role] ?? 0) + l.debitCents - l.creditCents
  return out
}

export const byType = (entries: DerivedEntry[], type: string) => entries.filter((e) => e.eventType === type)
