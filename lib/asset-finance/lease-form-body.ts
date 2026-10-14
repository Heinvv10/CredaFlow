// The new-deal form's lease fields → the deal API body for an operating or
// full-maintenance lease (lib/asset-finance/lease-input.ts). Pure and
// client-safe, like ./deal-form-body.ts: rands and percent strings convert
// with string arithmetic. A lease has no deposit, trade-in, financed fee or
// VAT deferral, and its structure is MONTHLY (the weights are the escalation),
// so those never reach the body. Field errors use the API's field names.
import { dealStructureBody, type DealFormValues } from "./deal-form-body"
import { percentToDecimal } from "./deal-labels"
import type { LeaseContractType, MaintenanceRiskModel, UsageUnit } from "./lease-input"
import { randsToCents } from "./money-input"
import type { RentalTiming } from "./lease-pricing"

export interface LeaseFormValues {
  rentalTiming: RentalTiming
  escalationPercent: string // the rental's annual escalation, blank for none
  penaltyPercent: string // the early-termination penalty on the PV of the remaining rentals
  maintenanceRands: string // FML: a month, ex VAT
  maintenanceEscalationPercent: string
  riskModel: MaintenanceRiskModel
  usageAllowance: string // units a year
  usageUnit: UsageUnit
  excessRateRands: string // per unit, ex VAT
}

export const LEASE_INITIAL: LeaseFormValues = {
  rentalTiming: "ARREARS", escalationPercent: "", penaltyPercent: "", maintenanceRands: "", maintenanceEscalationPercent: "",
  riskModel: "LENDER_RISK", usageAllowance: "", usageUnit: "HOURS", excessRateRands: "",
}

const WHOLE = /^\d+$/

export function leaseDealBody(
  base: DealFormValues,
  lease: LeaseFormValues,
  contractType: LeaseContractType,
): { body: Record<string, unknown>; errors: Record<string, string> } {
  // The rate, residual (balloon), first due date and term are the instalment form's own fields.
  const { body, errors } = dealStructureBody({
    ...base, contractType: "INSTALMENT_SALE", depositRands: "", tradeInRands: "", feesRands: "", vatDeferralPeriod: "", preset: "MONTHLY",
  })
  for (const key of ["depositCents", "tradeInCents", "financedFeesCents"]) delete body[key]
  body.contractType = contractType
  body.rentalTiming = lease.rentalTiming

  const rate = (key: string, text: string, required: boolean, example: string) => {
    if (text.trim() === "") {
      if (required) errors[key] = `A rate in percent, e.g. ${example}`
      return required ? null : "0"
    }
    const decimal = percentToDecimal(text, false)
    if (decimal === null) errors[key] = `A rate in percent, e.g. ${example}`
    return decimal
  }
  const escalation = rate("escalationRate", lease.escalationPercent, false, "8")
  if (escalation !== null) body.escalationRate = escalation
  const penalty = rate("earlyTerminationPenaltyRate", lease.penaltyPercent, true, "10")
  if (penalty !== null) body.earlyTerminationPenaltyRate = penalty

  const fml = contractType === "FULL_MAINTENANCE_LEASE"
  if (fml) {
    const monthly = lease.maintenanceRands.trim() === "" ? null : randsToCents(lease.maintenanceRands)
    if (monthly === null || monthly < 1) errors.maintenanceMonthlyExclVatCents = "A monthly amount in rand ex VAT, e.g. 2500.00"
    else body.maintenanceMonthlyExclVatCents = monthly
    const maintenanceEscalation = rate("maintenanceEscalationRate", lease.maintenanceEscalationPercent, true, "6")
    if (maintenanceEscalation !== null) body.maintenanceEscalationRate = maintenanceEscalation
    body.maintenanceRiskModel = lease.riskModel
  }

  // Usage is required on a full-maintenance lease; on an operating lease all of it or none.
  const allowance = lease.usageAllowance.trim()
  const excess = lease.excessRateRands.trim()
  if (fml || allowance !== "" || excess !== "") {
    if (!WHOLE.test(allowance) || Number(allowance) < 1) errors.usageAllowancePerYear = "A whole number of hours or km a year"
    else body.usageAllowancePerYear = Number(allowance)
    const excessCents = excess === "" ? null : randsToCents(excess)
    if (excessCents === null || excessCents < 1) errors.excessRateCents = "An amount in rand per hour or km, ex VAT, e.g. 450.00"
    else body.excessRateCents = excessCents
    body.usageUnit = lease.usageUnit
  }
  return { body, errors }
}
