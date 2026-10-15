/**
 * The lease part of a deal body (slice 3, C1/C3): POST /api/asset-finance/deals
 * and /deals/preview with contractType OPERATING_LEASE or FULL_MAINTENANCE_LEASE.
 *
 * A lease has no deposit, trade-in, financed fee or VAT deferral (the capital
 * is the cash price ex VAT, ./lease-pricing.ts) and a MONTHLY preset: its
 * weights are the annual escalation. `balloonCents` is the residual. Rates are
 * decimal strings with at most 6 places (DECIMAL(9,6)), from 0 to below 1.
 *
 * Full-maintenance lease: the maintenance amount, its escalation, the fund's
 * risk model and the contracted usage (allowance, unit, excess rate) are all
 * required. Operating lease: no maintenance; contracted usage is optional,
 * all three fields or none. The database holds the same shape
 * (AssetFinanceDeal_lease_terms_shape).
 */
import type { ContractType } from "@prisma/client"
import { MAX_INT, readEnum, readInt, type Errors, type Fields } from "./input-fields"
import { RENTAL_TIMINGS, type RentalTiming } from "./lease-pricing"

export const LEASE_CONTRACT_TYPES = ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] as const satisfies readonly ContractType[]
export type LeaseContractType = (typeof LEASE_CONTRACT_TYPES)[number]
export const MAINTENANCE_RISK_MODELS = ["LENDER_RISK", "LESSEE_SETTLED"] as const
export type MaintenanceRiskModel = (typeof MAINTENANCE_RISK_MODELS)[number]
export const USAGE_UNITS = ["HOURS", "KM"] as const
export type UsageUnit = (typeof USAGE_UNITS)[number]

export const isLeaseContract = (type: string): type is LeaseContractType =>
  (LEASE_CONTRACT_TYPES as readonly string[]).includes(type)

export interface LeaseUsage {
  allowancePerYear: number
  unit: UsageUnit
  excessRateCents: number // per hour or km, ex VAT
}

export interface LeaseMaintenanceTerms {
  monthlyExclVatCents: number
  escalationRate: string
  riskModel: MaintenanceRiskModel
}

export interface LeaseTerms {
  rentalTiming: RentalTiming
  escalationRate: string
  earlyTerminationPenaltyRate: string
  maintenance: LeaseMaintenanceTerms | null // FML only
  usage: LeaseUsage | null // required on an FML
}

const RATE = /^0(\.\d{1,6})?$/

function readRate(body: Fields, key: string, errors: Errors, required: boolean): string | null {
  const raw = body[key]
  if (raw === undefined || raw === null || raw === "") {
    if (required) errors[key] = "is required: an annual decimal from 0 to below 1, e.g. 0.08"
    return null
  }
  const text = typeof raw === "number" ? String(raw) : raw
  if (typeof text !== "string" || !RATE.test(text)) {
    errors[key] = "must be an annual decimal from 0 to below 1 with at most 6 places, e.g. 0.08"
    return null
  }
  return text
}

const present = (body: Fields, key: string) => body[key] !== undefined && body[key] !== null && body[key] !== ""

function readUsage(body: Fields, errors: Errors, required: boolean): LeaseUsage | null {
  const keys = ["usageAllowancePerYear", "usageUnit", "excessRateCents"]
  if (!required && keys.every((k) => !present(body, k))) return null
  const out: Fields = {}
  readInt(body, "usageAllowancePerYear", out, errors, { required: true, nullable: false, min: 1, max: MAX_INT })
  readEnum(body, "usageUnit", out, errors, { required: true, values: USAGE_UNITS })
  readInt(body, "excessRateCents", out, errors, { required: true, nullable: false, min: 1, max: MAX_INT })
  if (keys.some((k) => out[k] === undefined)) return null
  return { allowancePerYear: out.usageAllowancePerYear as number, unit: out.usageUnit as UsageUnit, excessRateCents: out.excessRateCents as number }
}

function readMaintenance(body: Fields, errors: Errors): LeaseMaintenanceTerms | null {
  const out: Fields = {}
  readInt(body, "maintenanceMonthlyExclVatCents", out, errors, { required: true, nullable: false, min: 1, max: MAX_INT })
  const escalationRate = readRate(body, "maintenanceEscalationRate", errors, true)
  readEnum(body, "maintenanceRiskModel", out, errors, { required: true, values: MAINTENANCE_RISK_MODELS })
  if (out.maintenanceMonthlyExclVatCents === undefined || escalationRate === null || out.maintenanceRiskModel === undefined) return null
  return {
    monthlyExclVatCents: out.maintenanceMonthlyExclVatCents as number,
    escalationRate,
    riskModel: out.maintenanceRiskModel as MaintenanceRiskModel,
  }
}

const FML_ONLY = ["maintenanceMonthlyExclVatCents", "maintenanceEscalationRate", "maintenanceRiskModel"]
const NOT_ON_A_LEASE = ["depositCents", "tradeInCents", "financedFeesCents"]

/** Parses the lease fields of `body`; errors go into `errors` under the API's field names. */
export function readLeaseTerms(body: Fields, contractType: LeaseContractType, errors: Errors): LeaseTerms | null {
  for (const key of NOT_ON_A_LEASE) {
    if (present(body, key) && body[key] !== 0) errors[key] = "must be 0 on a lease: the capital is the cash price ex VAT (use ADVANCE timing for a rental in advance)"
  }
  if (present(body, "vatDeferralPeriodIndex")) errors.vatDeferralPeriodIndex = "does not apply to a lease: VAT is charged on every rental"
  const preset = body.preset
  if (typeof preset === "object" && preset !== null && (preset as Fields).kind !== "MONTHLY") {
    errors["preset.kind"] = "must be MONTHLY on a lease: the rental escalates annually by escalationRate"
  }
  const out: Fields = {}
  readEnum(body, "rentalTiming", out, errors, { required: true, values: RENTAL_TIMINGS })
  const escalationRate = readRate(body, "escalationRate", errors, false) ?? (present(body, "escalationRate") ? null : "0")
  const penalty = readRate(body, "earlyTerminationPenaltyRate", errors, true)
  const fml = contractType === "FULL_MAINTENANCE_LEASE"
  const maintenance = fml ? readMaintenance(body, errors) : null
  if (!fml) for (const key of FML_ONLY) if (present(body, key)) errors[key] = "applies to a full-maintenance lease only"
  const usage = readUsage(body, errors, fml)
  if (out.rentalTiming === undefined || escalationRate === null || penalty === null || (fml && (!maintenance || !usage))) return null
  return { rentalTiming: out.rentalTiming as RentalTiming, escalationRate, earlyTerminationPenaltyRate: penalty, maintenance, usage }
}
