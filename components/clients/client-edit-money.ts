import type { ExpenseBreakdownData } from "./ExpenseBreakdownSection"
import type { DebtObligation } from "./DebtObligationsSection"

const EMPTY_EXPENSES: ExpenseBreakdownData = {
  housing: 0, transport: 0, food: 0, education: 0,
  insurance: 0, clothing: 0, entertainment: 0, medical: 0, other: 0,
}

// The client Edit form (ClientFormLegacy) loads expense/debt data as RAW Prisma
// rows: amounts in integer CENTS, alongside non-editable columns (id, clientId,
// updatedAt). Seeding the editable state must:
//   (a) keep only the known form fields, including the NCA Regulation 23A
//       justification; and
//   (b) divide by 100 so the inputs show rands, mirroring the /100 already applied
//       to grossMonthlyIncome/monthlyIncome.
// Without the /100 here, handleSubmit's single `* 100` double-converts on every
// re-save, inflating stored expenses/debt ×100 (compounding per save) and wrecking
// the NDI/affordability figures.
// The single rands -> cents conversion for this form. Two defects live in the
// naive versions it replaces:
//   parseInt("7230.99") * 100  -> 723000  (cents discarded on every save)
//   Number("1500.99") * 100    -> 150098.99999999999  (Prisma rejects a
//                                 non-integer for an Int column)
// Income is fingerprinted into the immutable approval snapshot, so the first one
// is not a rounding nicety: a save that quietly rounds income down invalidates
// an already-approved application and blocks its payout.
export function randsToCents(value: unknown): number {
  const rands = typeof value === "number" ? value : Number(String(value ?? "").trim())
  if (!Number.isFinite(rands)) return 0
  return Math.round(rands * 100)
}

export function centsToRandExpenses(
  eb?: Partial<ExpenseBreakdownData> | null,
): ExpenseBreakdownData {
  if (!eb) return { ...EMPTY_EXPENSES }
  const toRand = (v: number | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v / 100 : 0
  return {
    housing: toRand(eb.housing),
    transport: toRand(eb.transport),
    food: toRand(eb.food),
    education: toRand(eb.education),
    insurance: toRand(eb.insurance),
    clothing: toRand(eb.clothing),
    entertainment: toRand(eb.entertainment),
    medical: toRand(eb.medical),
    other: toRand(eb.other),
    ...(typeof eb.belowMleJustification === "string"
      ? { belowMleJustification: eb.belowMleJustification }
      : {}),
  }
}

// Debts: /100 only the two money fields; the spread keeps `notes` (read
// server-side, but with no field in this legacy form) and any other raw columns
// passing through unchanged. DebtObligationsSection reads fields by name (never
// Object.values), so the ride-along columns are inert — unlike the expense path.
export function centsToRandDebts<
  T extends { outstandingBalance: number; monthlyInstalment: number },
>(debts?: T[] | null): T[] {
  return (debts ?? []).map((d) => ({
    ...d,
    outstandingBalance: d.outstandingBalance / 100,
    monthlyInstalment: d.monthlyInstalment / 100,
  }))
}

export type { ExpenseBreakdownData, DebtObligation }
