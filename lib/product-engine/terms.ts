/**
 * A product's configuration as a version carries it (spec 2.1.2): limits, price, repayment structure, collateral and
 * eligibility. Pure: parsing and the rules that need no database. What needs one (the NCA interest ceiling, which reads
 * the repo rate) is checked by the change handler (change-handlers.ts).
 */
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { Problems, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { NCA_ASSET_CAPS } from "@/lib/asset-finance/nca-caps"
import { FREQUENCIES, GRACE_KINDS, PERIOD_DAYS, PERIODS_PER_YEAR, STRUCTURES, type Frequency, type GraceKind, type RepaymentStructure, type RepaymentTerms } from "./types"

export interface RepaymentSpec {
  frequency: Frequency
  structure: RepaymentStructure
  graceKind: GraceKind
  graceInstalments: number
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
  collateral: CollateralRequirement[]
  eligibility: EligibilityRules
}

const INT4_MAX = 2_147_483_647
const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INT4_MAX

const CONFIG_KEYS = [
  "minAmountCents", "maxAmountCents", "minTermDays", "maxTermDays", "interestRatePm", "interestModel", "initiationFeeModel", "initiationFeePct",
  "initiationFeeMaxCents", "monthlyServiceFeeCents", "repayment", "collateral", "eligibility",
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
  rejectUnknownKeys(raw, ["frequency", "structure", "graceKind", "graceInstalments"], "repayment", problems)
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
  if (graceKind === "NONE" && graceInstalments !== 0) problems.add("repayment.graceInstalments", "grace periods need a grace kind")
  if (graceKind !== "NONE" && graceInstalments < 1) problems.add("repayment.graceInstalments", "a grace kind needs at least 1 grace period")
  if (graceKind === "PRINCIPAL_ONLY" && structure !== "AMORTISING") problems.add("repayment", "a principal-only grace belongs to an amortising structure: interest-only and bullet already defer the principal")
  if (graceKind !== "NONE" && structure === "BULLET") problems.add("repayment", "a bullet has a single payment at the end: it has no grace")
  if (graceKind !== "NONE" && graceInstalments >= instalmentsFor(config.minTermDays, frequency)) {
    problems.add("repayment.graceInstalments", `the shortest term (${config.minTermDays} days) is ${instalmentsFor(config.minTermDays, frequency)} instalments: the grace must leave at least one to pay`)
  }
  return { frequency, structure, graceKind, graceInstalments }
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
    repayment, collateral, eligibility,
  }
}

/**
 * The instalment affordability sets against MONTHLY income, as a monthly figure: the regular instalment x periods a year
 * / 12 (weekly 52/12, fortnightly 26/12). The regular instalment is the largest after the first row (which carries the
 * one-off initiation fee), so a grace period's smaller payments never understate the burden; a single payment is itself.
 */
export function monthlyEquivalentInstalment(rows: ReadonlyArray<{ totalDue: number }>, frequency: Frequency): number {
  if (rows.length === 0) return 0
  const regular = rows.length === 1 ? rows[0]!.totalDue : Math.max(...rows.slice(1).map((r) => r.totalDue))
  return frequency === "MONTHLY" ? regular : Math.round((regular * PERIODS_PER_YEAR[frequency]) / 12)
}

/**
 * What an NCA lender may configure for now. A monthly, amortising, reducing-balance structure (or none) is what the
 * existing schedules, PASQ and credit agreement describe and what the engine reproduces to the cent
 * (lib/product-engine/schedule.test.ts); every other structure would reach a consumer through documents the lender's
 * legal team has not signed off, so it is refused until they do. The monthly service fee may not exceed the Regulation 44
 * ceiling of R60 plus VAT.
 */
export function ncaStructureIssues(config: ProductConfig): string[] {
  const issues: string[] = []
  const r = config.repayment
  if (r) {
    if (r.frequency !== "MONTHLY") issues.push("repayment.frequency: an NCA lender's documents describe monthly instalments only; a weekly or fortnightly structure needs the lender's legal sign-off of the rendered documents first")
    if (r.structure !== "AMORTISING") issues.push("repayment.structure: interest-only and bullet structures need the lender's legal sign-off of the rendered NCA documents first")
    if (r.graceKind !== "NONE") issues.push("repayment.graceKind: a grace period needs the lender's legal sign-off of the rendered NCA documents first")
    if (config.interestModel !== "REDUCING_BALANCE") issues.push("interestModel: an instalment structure for an NCA lender is reducing-balance, the basis the documents state")
  }
  const feeCeiling = Math.round(NCA_ASSET_CAPS.monthlyServiceFeeCents * 1.15)
  if (config.monthlyServiceFeeCents > feeCeiling) issues.push(`monthlyServiceFeeCents: above the Regulation 44 ceiling of ${feeCeiling} cents (R60 plus VAT)`)
  return issues
}
