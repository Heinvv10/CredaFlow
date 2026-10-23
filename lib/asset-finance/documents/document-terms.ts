// The term and arrears checks a deal document makes when it is rendered
// (./deal-document-data.ts re-exports them).
import type { Prisma } from "@prisma/client"

export function preparedTermProblem(termDays: number, approvedTermDays: number | null, minTermDays: number, maxTermDays: number): string | null {
  if (termDays < minTermDays || termDays > maxTermDays) {
    return `The prepared term of ${termDays} days is outside the product's ${minTermDays}–${maxTermDays}`
  }
  return approvedTermProblem(termDays, approvedTermDays)
}

/** Existing prepared documents remain governed by their credit decision, not later product edits. */
export function approvedTermProblem(termDays: number, approvedTermDays: number | null): string | null {
  return approvedTermDays === null || termDays > approvedTermDays
    ? `The prepared term of ${termDays} days exceeds the approved term${approvedTermDays === null ? "" : ` of ${approvedTermDays} days`}; obtain a new credit decision`
    : null
}

export function documentTermProblem(
  preparing: boolean,
  termDays: number,
  approvedTermDays: number | null,
  minTermDays: number,
  maxTermDays: number,
): string | null {
  return preparing
    ? preparedTermProblem(termDays, approvedTermDays, minTermDays, maxTermDays)
    : approvedTermProblem(termDays, approvedTermDays)
}

export function decimalString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString()
}

export function snapshotArrearsMargin(margin: Prisma.Decimal | null): string | null {
  return margin?.toString() ?? null
}
