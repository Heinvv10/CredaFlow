import type { RecoveryCostTreatment, RecoveryCostType, RecoveryRoute, RecoveryStatus } from "@prisma/client"

// Labels, the stepper and the cost-treatment choices of the staff recovery
// panel. Presentation only: the status matrix, route-to-regime rules and the
// cost allow-lists are enforced by lib/asset-finance/recovery-*.ts and the
// database (guardRecovery, guardRecoveryCost); the choices here only spare
// staff a refused round trip.

export const ROUTE_LABELS: Record<RecoveryRoute, string> = {
  NCA_S127_SURRENDER: "NCA s127 surrender",
  NCA_S131_ATTACHMENT: "NCA s131 attachment",
  NON_NCA_VOLUNTARY: "Voluntary hand-over (non-NCA)",
  NON_NCA_COURT_ORDER: "Court order (non-NCA)",
}

export const STATUS_LABELS: Record<RecoveryStatus, string> = {
  RECOVERED: "Recovered",
  VALUED: "Valued",
  VALUATION_NOTICE_ISSUED: "Valuation notice issued",
  LISTED: "Listed for sale",
  SOLD: "Sold",
  PROCEEDS_APPLIED: "Proceeds applied",
  FINAL_NOTICE_ISSUED: "Final notice issued",
  SHORTFALL_OPEN: "Shortfall open",
  SURPLUS_HELD: "Surplus held",
  CLOSED: "Closed",
  WITHDRAWN: "Withdrawn",
}

export const VALUATION_SOURCE_LABELS = { ASSESSOR: "Assessor", DEALER: "Dealer", AUCTIONEER: "Auctioneer", INTERNAL: "Internal" } as const

export const isNcaRoute = (route: RecoveryRoute): boolean => route.startsWith("NCA_")

export type StepState = "done" | "current" | "todo"
export interface StepperStep { key: string; label: string; state: StepState }

const NCA_PATH: RecoveryStatus[] = ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"]
const NON_NCA_PATH: RecoveryStatus[] = ["RECOVERED", "VALUED", "LISTED", "SOLD", "PROCEEDS_APPLIED"]
const OUTCOMES: RecoveryStatus[] = ["SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED"]

/**
 * The route's path as a stepper: an NCA route shows the notice steps, a
 * non-NCA one skips them. The last step is the outcome (shortfall, surplus or
 * closed). A withdrawn recovery has no path to show (null).
 */
export function recoveryStepper(route: RecoveryRoute, status: RecoveryStatus): StepperStep[] | null {
  if (status === "WITHDRAWN") return null
  const path = isNcaRoute(route) ? NCA_PATH : NON_NCA_PATH
  const outcome = OUTCOMES.includes(status)
  const at = outcome ? path.length : path.indexOf(status)
  const steps: StepperStep[] = path.map((step, index) => ({
    key: step, label: STATUS_LABELS[step], state: index < at ? "done" : index === at ? "current" : "todo",
  }))
  steps.push({
    key: "OUTCOME", label: outcome ? STATUS_LABELS[status] : "Outcome",
    state: status === "CLOSED" ? "done" : outcome ? "current" : "todo",
  })
  return steps
}

/** A recovery can be withdrawn until the asset is sold. */
export const canWithdraw = (status: RecoveryStatus): boolean => ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED"].includes(status)

export interface CostAllowLists { ncaDeductible: RecoveryCostType[]; nonNcaChargeable: RecoveryCostType[] }

/**
 * The treatments a cost type may take on a route: an NCA recovery deducts the
 * tenant's deductible types from the proceeds and charges only taxed legal
 * costs to the account; a non-NCA one allows either for its chargeable types.
 * UNTESTED: legal sign-off (the allow-lists are TenantConfig columns).
 */
export function costTreatments(route: RecoveryRoute, type: RecoveryCostType, lists: CostAllowLists): RecoveryCostTreatment[] {
  if (isNcaRoute(route)) {
    return [...(lists.ncaDeductible.includes(type) ? ["DEDUCT_FROM_PROCEEDS" as const] : []), ...(type === "LEGAL_TAXED" ? ["CHARGE_TO_ACCOUNT" as const] : [])]
  }
  return lists.nonNcaChargeable.includes(type) ? ["DEDUCT_FROM_PROCEEDS", "CHARGE_TO_ACCOUNT"] : []
}

/** The ledger's short form (the status column has to fit beside it). */
export const TREATMENT_SHORT: Record<RecoveryCostTreatment, string> = { DEDUCT_FROM_PROCEEDS: "Deducted", CHARGE_TO_ACCOUNT: "Charged" }

export const TREATMENT_LABELS: Record<RecoveryCostTreatment, string> = {
  DEDUCT_FROM_PROCEEDS: "Deducted from the proceeds",
  CHARGE_TO_ACCOUNT: "Charged to the account",
}

/** A cost can be added until the sale proceeds are applied (the database refuses it after). */
export const costsOpen = (status: RecoveryStatus): boolean => ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED", "SOLD"].includes(status)

/** Whether RecoveryNextStep has an action for the status (so the panel shows its heading only then). */
export const hasNextStep = (status: RecoveryStatus): boolean =>
  ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED", "SHORTFALL_OPEN"].includes(status)
