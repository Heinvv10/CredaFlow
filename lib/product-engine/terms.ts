/**
 * A product's configuration as a version carries it (spec 2.1.2): limits, price, repayment structure, collateral and
 * eligibility. Pure: parsing and the rules that need no database. What needs one (the NCA interest ceiling, which reads
 * the repo rate) is checked by the change handler (change-handlers.ts).
 */
import { graceRuleProblems } from "./grace-rules"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { NCA_ASSET_CAPS } from "@/lib/asset-finance/nca-caps"
import { FREQUENCIES, GRACE_KINDS, PERIOD_DAYS, STRUCTURES, VARIABLE_RATE_BASES, type Frequency, type GraceKind, type RepaymentStructure, type RepaymentTerms, type VariableRateBasis } from "./types"

export { monthlyEquivalentInstalment } from "./instalment"

export interface RepaymentSpec {
  frequency: Frequency
  structure: RepaymentStructure
  graceKind: GraceKind
  graceInstalments: number
  /** BALLOON only: the share of the principal left to the last instalment. */
  balloonPct?: number
}

/** A rate that follows a reference: an annual reference + an annual margin, divided by 12 for the monthly rate. */
export interface VariableRateSpec {
  basis: VariableRateBasis
  /** Annual decimal, may be negative: 0.02 = reference + 2%. */
  marginPa: number
}

export interface CollateralRequirement {
  code: string
  description: string
  required: boolean
}

export interface EligibilityRules {
  minAge: number | null
  maxAge: number | null
  minMonthlyIncomeCents: number | null
  minEmploymentMonths: number | null
}

export interface ProductConfig {
  minAmountCents: number
  maxAmountCents: number
  minTermDays: number
  maxTermDays: number
  /** Monthly rate as a decimal: 0.03 = 3% a month. */
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMaxCents: number
  monthlyServiceFeeCents: number
  /** Null: the product keeps its existing behaviour (a single payment, or monthly instalments, by interestModel). */
  repayment: RepaymentSpec | null
  /** Null: a fixed rate. Set: loans are priced off the reference and repriced with it; interestRatePm is the advertised figure only. */
  variableRate: VariableRateSpec | null
  collateral: CollateralRequirement[]
  eligibility: EligibilityRules
}

const INT4_MAX = 2_147_483_647
const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INT4_MAX

const CONFIG_KEYS = [
  "minAmountCents", "maxAmountCents", "minTermDays", "maxTermDays", "interestRatePm", "interestModel", "initiationFeeModel", "initiationFeePct",
  "initiationFeeMaxCents", "monthlyServiceFeeCents", "repayment", "variableRate", "collateral", "eligibility",
] as const

/** Instalments a loan of `termDays` has: the 30-day month, as the rest of billing counts it. */
export function instalmentsFor(termDays: number, frequency: Frequency): number {
  return Math.max(1, Math.round(termDays / PERIOD_DAYS[frequency]))
}

/** The engine's terms for a loan of `termDays` on this product structure. */
export function repaymentTermsFor(spec: RepaymentSpec, termDays: number): RepaymentTerms {
  return { ...spec, instalments: instalmentsFor(termDays, spec.frequency) }
}

function parseRepayment(raw: unknown, config: { minTermDays: number; interestModel: unknown }, problems: Problems): RepaymentSpec | null {
  if (raw === null) return null
  if (!isObject(raw)) {
    problems.add("repayment", "an object, or null for the product's existing behaviour")
    return null
  }
  rejectUnknownKeys(raw, ["frequency", "structure", "graceKind", "graceInstalments", "balloonPct"], "repayment", problems)
  const frequency = (FREQUENCIES as readonly unknown[]).includes(raw.frequency) ? (raw.frequency as Frequency) : null
  const structure = (STRUCTURES as readonly unknown[]).includes(raw.structure) ? (raw.structure as RepaymentStructure) : null
  const graceKind = (GRACE_KINDS as readonly unknown[]).includes(raw.graceKind) ? (raw.graceKind as GraceKind) : null
  if (!frequency) problems.add("repayment.frequency", `one of ${FREQUENCIES.join(", ")}`)
  if (!structure) problems.add("repayment.structure", `one of ${STRUCTURES.join(", ")}`)
  if (!graceKind) problems.add("repayment.graceKind", `one of ${GRACE_KINDS.join(", ")}`)
  const graceInstalments = raw.graceInstalments
  if (typeof graceInstalments !== "number" || !Number.isInteger(graceInstalments) || graceInstalments < 0 || graceInstalments > 60) {
    problems.add("repayment.graceInstalments", "a whole number of periods, 0 to 60")
  }
  if (!frequency || !structure || !graceKind || typeof graceInstalments !== "number") return null
  if (config.interestModel === "DAILY_ACCRUAL") problems.add("repayment", "a daily-accrual product is a single payment: it has no repayment structure")
  for (const p of graceRuleProblems(structure, graceKind, graceInstalments)) problems.add(p.path, p.message)
  if (graceKind !== "NONE" && graceInstalments >= instalmentsFor(config.minTermDays, frequency)) {
    problems.add("repayment.graceInstalments", `the shortest term (${config.minTermDays} days) is ${instalmentsFor(config.minTermDays, frequency)} instalments: the grace must leave at least one to pay`)
  }
  const balloonPct = raw.balloonPct
  if (structure !== "BALLOON") {
    if (balloonPct !== undefined) problems.add("repayment.balloonPct", "only a balloon structure has a balloon share")
    return { frequency, structure, graceKind, graceInstalments }
  }
  if (typeof balloonPct !== "number" || !Number.isFinite(balloonPct) || balloonPct <= 0 || balloonPct >= 1) problems.add("repayment.balloonPct", "the share of the principal left to the last instalment, above 0 and below 1")
  if (instalmentsFor(config.minTermDays, frequency) < 2) problems.add("repayment.balloonPct", `the shortest term (${config.minTermDays} days) is one instalment: a balloon needs at least two`)
  return { frequency, structure, graceKind, graceInstalments, balloonPct: balloonPct as number }
}

/**
 * A repricing regenerates the rows still to come from the balance, so a variable rate needs a reducing balance over several
 * rows with nothing deferred into them: not a flat rate, a single payment, or a full grace.
 */
function parseVariableRate(raw: unknown, repayment: RepaymentSpec | null, interestModel: unknown, problems: Problems): VariableRateSpec | null {
  if (raw === null) return null
  if (!isObject(raw)) {
    problems.add("variableRate", "{ basis, marginPa }, or null for a fixed rate")
    return null
  }
  rejectUnknownKeys(raw, ["basis", "marginPa"], "variableRate", problems)
  const basis = (VARIABLE_RATE_BASES as readonly unknown[]).includes(raw.basis) ? (raw.basis as VariableRateBasis) : null
  if (!basis) problems.add("variableRate.basis", `one of ${VARIABLE_RATE_BASES.join(", ")}`)
  const marginPa = raw.marginPa
  if (typeof marginPa !== "number" || !Number.isFinite(marginPa) || marginPa <= -1 || marginPa >= 1) problems.add("variableRate.marginPa", "an annual margin as a decimal, above -1 and below 1")
  if (interestModel !== "REDUCING_BALANCE") problems.add("variableRate", "a variable rate needs a reducing balance: a flat rate is fixed on the original principal")
  if (!repayment) problems.add("variableRate", "a variable rate needs a repayment structure: the schedule is regenerated by the engine")
  else if (repayment.structure === "BULLET") problems.add("variableRate", "a bullet has one period and nothing left to reprice")
  else if (repayment.graceKind === "FULL") problems.add("variableRate", "a full grace defers interest into later rows, which a repricing cannot regenerate")
  return basis && typeof marginPa === "number" ? { basis, marginPa } : null
}

export function parseProductConfig(raw: unknown): ProductConfig {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, CONFIG_KEYS, "payload", problems)

  for (const key of ["minAmountCents", "maxAmountCents"] as const) {
    if (!isCents(raw[key]) || (raw[key] as number) < 1) problems.add(key, "a positive whole number of cents")
  }
  if (isCents(raw.minAmountCents) && isCents(raw.maxAmountCents) && raw.maxAmountCents < raw.minAmountCents) problems.add("maxAmountCents", "not below the minimum")
  for (const key of ["minTermDays", "maxTermDays"] as const) {
    if (!isCents(raw[key]) || (raw[key] as number) < 1) problems.add(key, "a positive whole number of days")
  }
  if (isCents(raw.minTermDays) && isCents(raw.maxTermDays) && raw.maxTermDays < raw.minTermDays) problems.add("maxTermDays", "not below the minimum")

  if (typeof raw.interestRatePm !== "number" || !Number.isFinite(raw.interestRatePm) || raw.interestRatePm < 0 || raw.interestRatePm >= 1) problems.add("interestRatePm", "a monthly rate from 0 up to (not including) 1 (100%)")
  if (raw.interestModel !== "FLAT" && raw.interestModel !== "REDUCING_BALANCE" && raw.interestModel !== "DAILY_ACCRUAL") problems.add("interestModel", "FLAT, REDUCING_BALANCE or DAILY_ACCRUAL")
  if (raw.initiationFeeModel !== "FLAT_PCT" && raw.initiationFeeModel !== "NCA_REG42") problems.add("initiationFeeModel", "FLAT_PCT or NCA_REG42")
  if (typeof raw.initiationFeePct !== "number" || !Number.isFinite(raw.initiationFeePct) || raw.initiationFeePct < 0 || raw.initiationFeePct > 1) problems.add("initiationFeePct", "a share of the principal from 0 to 1")
  for (const key of ["initiationFeeMaxCents", "monthlyServiceFeeCents"] as const) {
    if (!isCents(raw[key])) problems.add(key, "a whole number of cents, 0 or more")
  }

  const repayment = parseRepayment(raw.repayment === undefined ? null : raw.repayment, { minTermDays: Number(raw.minTermDays), interestModel: raw.interestModel }, problems)
  const variableRate = parseVariableRate(raw.variableRate === undefined ? null : raw.variableRate, repayment, raw.interestModel, problems)

  const collateral: CollateralRequirement[] = []
  if (!Array.isArray(raw.collateral) || raw.collateral.length > 20) problems.add("collateral", "a list of at most 20 requirements")
  else {
    const seen = new Set<string>()
    for (const [i, item] of raw.collateral.entries()) {
      if (!isObject(item) || typeof item.code !== "string" || !/^[A-Z][A-Z0-9_]{1,39}$/.test(item.code) || typeof item.description !== "string" || item.description.trim().length < 1 || item.description.length > 200 || typeof item.required !== "boolean") {
        problems.add(`collateral[${i}]`, "{ code: UPPER_SNAKE 2-40, description: 1-200 characters, required: boolean }")
        continue
      }
      if (seen.has(item.code)) problems.add(`collateral[${i}]`, `the code ${item.code} is listed twice`)
      seen.add(item.code)
      collateral.push({ code: item.code, description: item.description.trim(), required: item.required })
    }
  }

  const eligibility: EligibilityRules = { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }
  if (!isObject(raw.eligibility)) problems.add("eligibility", "an object (every rule null when unused)")
  else {
    rejectUnknownKeys(raw.eligibility, ["minAge", "maxAge", "minMonthlyIncomeCents", "minEmploymentMonths"], "eligibility", problems)
    for (const [key, max] of [["minAge", 120], ["maxAge", 120], ["minMonthlyIncomeCents", INT4_MAX], ["minEmploymentMonths", 600]] as const) {
      const v = raw.eligibility[key]
      if (v === null || v === undefined) continue
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) problems.add(`eligibility.${key}`, `a whole number from 0 to ${max}, or null`)
      else eligibility[key] = v
    }
    if (eligibility.minAge !== null && eligibility.maxAge !== null && eligibility.maxAge < eligibility.minAge) problems.add("eligibility", "the maximum age is below the minimum age")
  }

  problems.throwIfAny()
  return {
    minAmountCents: raw.minAmountCents as number, maxAmountCents: raw.maxAmountCents as number,
    minTermDays: raw.minTermDays as number, maxTermDays: raw.maxTermDays as number,
    interestRatePm: raw.interestRatePm as number, interestModel: raw.interestModel as ProductConfig["interestModel"],
    initiationFeeModel: raw.initiationFeeModel as ProductConfig["initiationFeeModel"], initiationFeePct: raw.initiationFeePct as number,
    initiationFeeMaxCents: raw.initiationFeeMaxCents as number, monthlyServiceFeeCents: raw.monthlyServiceFeeCents as number,
    repayment, variableRate, collateral, eligibility,
  }
}

/**
 * What an NCA lender may configure for now: no repayment structure at all. Its loans keep the existing instalment schedule
 * (lib/loan-calculator.ts), which is what the PASQ, the credit agreement, the debit-order mandate and the NCA schedules
 * describe to the cent, month-end dates included. Every engine structure, the monthly one too, would produce a schedule those
 * documents have not been signed off for, so it is refused until the lender's legal team signs off the rendered documents.
 * The monthly service fee may not exceed the Regulation 44 ceiling of R60 plus VAT.
 */
export function ncaStructureIssues(config: ProductConfig): string[] {
  const issues: string[] = []
  if (config.repayment) issues.push("repayment: an NCA lender's schedules, agreement and debit mandate are the existing monthly ones; a repayment structure needs the lender's legal sign-off of the rendered documents first")
  if (config.variableRate) issues.push("variableRate: an NCA lender's agreement and quotation state one fixed rate; a variable rate needs the lender's legal sign-off of the rendered documents first")
  const feeCeiling = Math.round(NCA_ASSET_CAPS.monthlyServiceFeeCents * 1.15)
  if (config.monthlyServiceFeeCents > feeCeiling) issues.push(`monthlyServiceFeeCents: above the Regulation 44 ceiling of ${feeCeiling} cents (R60 plus VAT)`)
  return issues
}
