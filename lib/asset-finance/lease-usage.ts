/**
 * Contracted usage of a lease (slice 3, C6). Pure, integer arithmetic.
 *
 *   excess units = final reading − start reading − allowance per year × term in years
 *   excess charge = max(0, excess units × excess rate), half-up to the cent, ex VAT
 * The term in years is termMonths / 12, so the arithmetic is kept in twelfths
 * of a unit. Billed once, at the end of the term, on the end-of-term tax
 * invoice (./lease-end-of-term.ts).
 *
 * The projection on the staff loan page extrapolates the usage per day so far
 * to the end date, then applies the same rule.
 */
import { toDayNumber } from "./dates"

export interface UsageInput {
  startReading: number
  finalReading: number
  allowancePerYear: number
  termMonths: number
  excessRateCents: number
}

export interface UsageResult {
  usedUnits: number
  allowedTwelfths: number
  excessTwelfths: number
  excessCents: number
}

function assertWhole(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name}: must be a non-negative whole number`)
}

export function excessUsage(input: UsageInput): UsageResult {
  for (const [name, value] of Object.entries(input)) assertWhole(name, value)
  if (input.finalReading < input.startReading) throw new RangeError("finalReading: must not be below the start reading")
  const usedUnits = input.finalReading - input.startReading
  const allowedTwelfths = input.allowancePerYear * input.termMonths
  const excessTwelfths = Math.max(0, usedUnits * 12 - allowedTwelfths)
  // excessTwelfths × rate / 12, half-up.
  const excessCents = Number((BigInt(excessTwelfths) * BigInt(input.excessRateCents) * BigInt(2) + BigInt(12)) / BigInt(24))
  return { usedUnits, allowedTwelfths, excessTwelfths, excessCents }
}

export interface ProjectionInput extends Omit<UsageInput, "finalReading"> {
  startDate: string
  latestReading: number
  latestDate: string
  endDate: string
}

export function projectedExcessUsage(input: ProjectionInput): UsageResult & { projectedFinalReading: number } {
  const start = toDayNumber(input.startDate, "startDate")
  const elapsed = toDayNumber(input.latestDate, "latestDate") - start
  const total = toDayNumber(input.endDate, "endDate") - start
  const used = input.latestReading - input.startReading
  const projectedFinalReading = elapsed <= 0 || total <= 0
    ? input.latestReading
    : input.startReading + Math.round((used * total) / elapsed)
  const { startReading, allowancePerYear, termMonths, excessRateCents } = input
  const finalReading = Math.max(projectedFinalReading, startReading)
  return { ...excessUsage({ startReading, finalReading, allowancePerYear, termMonths, excessRateCents }), projectedFinalReading }
}
