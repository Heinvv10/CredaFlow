// The new-deal form's typed values → the deal API body
// (lib/asset-finance/deal-input.ts). Pure and client-safe: rands and percent
// strings are converted with string arithmetic, so no float drifts into cents
// or rates. Field errors use the API's field names.
import type { ContractType, ReferenceRateBasis } from "@prisma/client"
import { randsToCents } from "./money-input"
import { percentToDecimal } from "./deal-labels"
import type { StructurePresetName } from "./deal-input"

export interface DealFormValues {
  assetId: string
  contractType: Extract<ContractType, "INSTALMENT_SALE" | "FINANCE_LEASE">
  depositRands: string
  tradeInRands: string
  feesRands: string
  balloonRands: string
  firstDueDate: string
  vatDeferralPeriod: string // 1-based period number, empty for none
  rateBasis: ReferenceRateBasis
  ratePercent: string // the margin for a reference basis, the rate for FIXED
  preset: StructurePresetName
  periods: string
  skipFirst: string
  seasonMonths: string // "3, 4, 5"
  seasonWeight: string
  offWeight: string
  months: string // "3, 9"
  steps: string // "12:1.5, 24:2" — from period (1-based) : weight
}

const numberList = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean).map(Number)

function presetBody(v: DealFormValues, errors: Record<string, string>): Record<string, unknown> {
  // Blank by default (a placeholder, never a prefilled value a keystroke appends to).
  if (!/^\d+$/.test(v.periods.trim()) || Number(v.periods) < 1) errors["preset.periods"] = "A whole number of months, e.g. 60"
  const periods = Number(v.periods)
  const preset: Record<string, unknown> = { kind: v.preset, periods }
  switch (v.preset) {
    case "SKIP_N":
      preset.skipFirst = Number(v.skipFirst || "0")
      break
    case "ANNUAL_SEASONAL":
      preset.seasonMonths = numberList(v.seasonMonths)
      preset.seasonWeight = Number(v.seasonWeight)
      preset.offWeight = Number(v.offWeight)
      break
    case "BIANNUAL":
      preset.months = numberList(v.months)
      break
    case "STEP_UP": {
      const steps = v.steps.split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
        const [from, weight] = pair.split(":").map((x) => Number(x.trim()))
        return { fromPeriod: from - 1, weight }
      })
      if (steps.some((s) => !Number.isFinite(s.fromPeriod) || !Number.isFinite(s.weight))) {
        errors["preset.steps"] = "Write steps as period:weight, e.g. 13:1.5, 25:2"
      }
      preset.steps = steps
      break
    }
    case "MONTHLY":
      break
  }
  return preset
}

export function dealStructureBody(v: DealFormValues): { body: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const money = (key: string, text: string) => {
    if (text.trim() === "") return 0
    const cents = randsToCents(text)
    if (cents === null) errors[key] = "An amount in rand, e.g. 250000.00"
    return cents ?? 0
  }
  const body: Record<string, unknown> = {
    assetId: v.assetId,
    contractType: v.contractType,
    depositCents: money("depositCents", v.depositRands),
    tradeInCents: money("tradeInCents", v.tradeInRands),
    financedFeesCents: money("financedFeesCents", v.feesRands),
    balloonCents: money("balloonCents", v.balloonRands),
    firstDueDate: v.firstDueDate,
    rateBasis: v.rateBasis,
    preset: presetBody(v, errors),
  }
  if (v.vatDeferralPeriod.trim() !== "") body.vatDeferralPeriodIndex = Number(v.vatDeferralPeriod) - 1
  const fixed = v.rateBasis === "FIXED"
  const rate = percentToDecimal(v.ratePercent, !fixed)
  if (rate === null) errors[fixed ? "fixedRate" : "rateMargin"] = fixed ? "A rate in percent, e.g. 13.5" : "A margin in percent, e.g. 1.5 or -0.5"
  else body[fixed ? "fixedRate" : "rateMargin"] = rate
  return { body, errors }
}
