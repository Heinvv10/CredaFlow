/**
 * Operating-lease and full-maintenance-lease rental pricing (slice 3, goal
 * §2a.5 and C2). Pure: no database, no clock. Money is integer cents, rates
 * are annual decimals, dates "YYYY-MM-DD". Built on the structure engine
 * (./amortise.ts, the rules documented on solveStructure in ./structure.ts).
 *
 * CAPITAL. The lender buys the asset and claims the input VAT, so the
 * capital a lease recovers is the cash price EXCLUDING VAT. A lease has no
 * deposit, trade-in or financed fee (a rental in advance is the ADVANCE
 * timing); VAT is charged on every rental instead (DESIGN D7).
 *
 * RESIDUAL. The lender's expected value of the asset at the end of the term.
 * The lessee never pays it: it is the solver's balloon, i.e. the balance
 * still outstanding immediately after the LAST rental. On an ADVANCE lease
 * that is one month before the term ends; the residual is not discounted for
 * that month (a documented simplification, DESIGN.md slice 3).
 *
 * TIMING. Period i (0-based) of an n-period lease is due on
 *   ADVANCE: commencement + i months, the first rental ON the commencement
 *            date (an annuity due: that period spans no days, no finance charge);
 *   ARREARS: firstDueDate + i months (default commencement + i + 1 months).
 * Finance charges accrue on the capital balance as in the solver: actual/365,
 * simple per period, rounded half-up once per period.
 *
 * ESCALATION. The rental escalates once a year by `escalationRate`, compounded:
 * period i carries weight w_i = (1 + e)^floor(i / 12), rounded half-up to six
 * decimals (escalationWeights, exact integer arithmetic). The solver finds the
 * base rental B; period i's rental ex VAT is round(B × w_i), the last period
 * absorbing the rounding residue so the capital lands exactly on the residual.
 *
 * MAINTENANCE (full-maintenance lease only). A monthly amount ex VAT M with its
 * own annual escalation m: period i charges round_half_up(M × mw_i), with
 * mw_i = (1 + m)^floor(i / 12) to six decimals. It is not part of the
 * capital: it funds the maintenance fund (C5).
 *
 * VAT. Rental and maintenance are standard-rated and invoiced as separate
 * lines, VAT half-up per line on the line's exclusive value (lib/vat/amounts):
 *   vat_i = vat(rental_i) + vat(maintenance_i);  total_i = rental_i + maintenance_i + vat_i.
 * The rate is the one passed in (in force on the pricing date); a later VAT
 * rate change is not re-priced here (lease-rental issuance refuses a mismatch).
 */
import { amortise, assertCents } from "./amortise"
import { addMonthsClamped, toDayNumber } from "./dates"
import { vatOnExclusive } from "@/lib/vat/amounts"
import type { RatePoint, ScheduleRow } from "./types"

export const RENTAL_TIMINGS = ["ADVANCE", "ARREARS"] as const
export type RentalTiming = (typeof RENTAL_TIMINGS)[number]

/** Weights and escalation factors carry six decimals. */
export const WEIGHT_SCALE = 1_000_000
const SCALE = BigInt(WEIGHT_SCALE)
const DECIMAL6 = /^(0|[1-9]\d*)(\.\d{1,6})?$/

export interface LeaseMaintenance {
  monthlyExclVatCents: number
  /** Annual decimal string with at most 6 places, e.g. "0.08". */
  escalationRate: string
}

export interface LeasePricingInput {
  cashPriceExclVatCents: number
  residualCents: number
  periods: number
  rentalTiming: RentalTiming
  /** Annual decimal string with at most 6 places, e.g. "0.10". */
  escalationRate: string
  /** The commencement date: the payout date, and on ADVANCE the first due date. */
  startDate: string
  /** ARREARS only: the first due date (after startDate). */
  firstDueDate?: string
  ratePath: RatePoint[]
  maintenance: LeaseMaintenance | null
  vatRateTenThousandths: number
}

export interface LeasePeriod {
  periodNo: number // 1-based
  dueDate: string
  rentalExclVatCents: number
  maintenanceExclVatCents: number
  vatCents: number
  totalCents: number
  /** The solver row: capital opening balance, finance charge and capital repaid. */
  row: ScheduleRow
}

export interface LeasePricingResult {
  capitalCents: number
  baseRentalCents: number
  weights: number[]
  periods: LeasePeriod[]
  totalRentalExclVatCents: number
  totalMaintenanceExclVatCents: number
  totalVatCents: number
  totalCents: number
}

/** A 6-place decimal string as an integer number of millionths; RangeError otherwise. */
export function decimal6(value: string, label: string): bigint {
  if (!DECIMAL6.test(value)) throw new RangeError(`${label}: must be a decimal with at most 6 places, e.g. 0.08`)
  const [whole, fraction = ""] = value.split(".")
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"))
}

/** (1 + rate)^floor(i / 12) for i in [0, n), in millionths, rounded half-up. */
export function escalationFactors(n: number, rate: string, label: string): bigint[] {
  const grow = SCALE + decimal6(rate, label)
  if (grow >= SCALE * BigInt(2)) throw new RangeError(`${label}: must be below 1`)
  const factors: bigint[] = []
  for (let i = 0; i < n; i++) {
    const years = Math.floor(i / 12)
    const numerator = grow ** BigInt(years)
    const denominator = SCALE ** BigInt(years)
    // (grow/SCALE)^years × SCALE, half-up: numerator × SCALE / denominator.
    factors.push((numerator * SCALE * BigInt(2) + denominator) / (denominator * BigInt(2)))
  }
  return factors
}

/** The rental weights w_i of an n-period lease with annual escalation `rate`. */
export function escalationWeights(n: number, rate: string): number[] {
  return escalationFactors(n, rate, "escalationRate").map((f) => Number(f) / WEIGHT_SCALE)
}

/** round_half_up(cents × factor / 10^6), exact. */
function scaleCents(cents: number, factor: bigint): number {
  return Number((BigInt(cents) * factor * BigInt(2) + SCALE) / (SCALE * BigInt(2)))
}

/** The maintenance charge ex VAT for each period. */
export function maintenanceCharges(n: number, maintenance: LeaseMaintenance): number[] {
  assertCents(maintenance.monthlyExclVatCents, "maintenance.monthlyExclVatCents")
  if (maintenance.monthlyExclVatCents <= 0) throw new RangeError("maintenance.monthlyExclVatCents: must be more than 0")
  return escalationFactors(n, maintenance.escalationRate, "maintenance.escalationRate")
    .map((factor) => scaleCents(maintenance.monthlyExclVatCents, factor))
}

export function leaseDueDates(input: Pick<LeasePricingInput, "startDate" | "firstDueDate" | "periods" | "rentalTiming">): string[] {
  const start = toDayNumber(input.startDate, "startDate")
  if (input.rentalTiming === "ADVANCE") {
    if (input.firstDueDate !== undefined && input.firstDueDate !== input.startDate) {
      throw new RangeError("firstDueDate: a rental in advance falls due on the commencement date")
    }
    return Array.from({ length: input.periods }, (_, i) => addMonthsClamped(input.startDate, i))
  }
  if (input.firstDueDate !== undefined && toDayNumber(input.firstDueDate, "firstDueDate") <= start) {
    throw new RangeError("firstDueDate: must be after startDate")
  }
  return Array.from({ length: input.periods }, (_, i) =>
    input.firstDueDate === undefined ? addMonthsClamped(input.startDate, i + 1) : addMonthsClamped(input.firstDueDate, i))
}

export function priceLease(input: LeasePricingInput): LeasePricingResult {
  assertCents(input.cashPriceExclVatCents, "cashPriceExclVatCents")
  assertCents(input.residualCents, "residualCents")
  if (input.cashPriceExclVatCents <= 0) throw new RangeError("cashPriceExclVatCents: must be more than 0")
  if (input.residualCents >= input.cashPriceExclVatCents) throw new RangeError("residualCents: must be less than the cash price ex VAT")
  if (!Number.isInteger(input.periods) || input.periods < 1) throw new RangeError("periods: must be a positive whole number")

  const weights = escalationWeights(input.periods, input.escalationRate)
  const dates = leaseDueDates(input)
  const { baseInstalmentCents, rows } = amortise({
    firstIndex: 0,
    openingCents: input.cashPriceExclVatCents,
    accrualStartDate: input.startDate,
    periods: dates.map((dueDate, i) => ({ dueDate, weight: weights[i], lumpCents: 0 })),
    ratePath: input.ratePath,
    balloonCents: input.residualCents,
    firstDueOnAccrualStart: input.rentalTiming === "ADVANCE",
  })
  const maintenance = input.maintenance === null ? null : maintenanceCharges(input.periods, input.maintenance)

  const periods = rows.map((row, i): LeasePeriod => {
    const rentalExclVatCents = row.totalCents - row.balloonCents
    if (rentalExclVatCents <= 0) throw new RangeError(`period ${i + 1}: the rental must be more than 0`)
    const maintenanceExclVatCents = maintenance?.[i] ?? 0
    const vatCents = vatOnExclusive(rentalExclVatCents, input.vatRateTenThousandths)
      + vatOnExclusive(maintenanceExclVatCents, input.vatRateTenThousandths)
    return {
      periodNo: i + 1,
      dueDate: row.dueDate,
      rentalExclVatCents,
      maintenanceExclVatCents,
      vatCents,
      totalCents: rentalExclVatCents + maintenanceExclVatCents + vatCents,
      row,
    }
  })
  const sum = (pick: (p: LeasePeriod) => number) => periods.reduce((total, p) => total + pick(p), 0)
  return {
    capitalCents: input.cashPriceExclVatCents,
    baseRentalCents: baseInstalmentCents,
    weights,
    periods,
    totalRentalExclVatCents: sum((p) => p.rentalExclVatCents),
    totalMaintenanceExclVatCents: sum((p) => p.maintenanceExclVatCents),
    totalVatCents: sum((p) => p.vatCents),
    totalCents: sum((p) => p.totalCents),
  }
}
