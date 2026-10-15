import type { RecoveryCostTreatment, RecoveryCostType, RecoveryRoute } from "@prisma/client"
import { COST_TYPES } from "./recovery-labels"
import type { RecoveryCostInput } from "./recovery-costs"
import type { StaffRecoveryInput } from "./recovery-store"

type Parsed<T> = { data: T } | { errors: Record<string, string> }

/** The two s127 / s131 routes run under the National Credit Act; the NON_NCA ones do not. */
export const isNcaRoute = (route: RecoveryRoute): boolean => route.startsWith("NCA_")

const ROUTES: RecoveryRoute[] = ["NCA_S127_SURRENDER", "NCA_S131_ATTACHMENT", "NON_NCA_VOLUNTARY", "NON_NCA_COURT_ORDER"]
const TREATMENTS: RecoveryCostTreatment[] = ["DEDUCT_FROM_PROCEEDS", "CHARGE_TO_ACCOUNT"]
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

const record = (body: unknown): Record<string, unknown> | null =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const optionalId = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/** The body of a staff-created recovery. The route, regime and link rules beyond shape are the database's. */
export function parseCreateRecovery(body: unknown): Parsed<StaffRecoveryInput> {
  const r = record(body)
  if (!r) return { errors: { body: "must be a JSON object" } }
  const errors: Record<string, string> = {}
  if (!ROUTES.includes(r.route as RecoveryRoute)) errors.route = `must be one of ${ROUTES.join(", ")}`
  if (!ISO_DAY.test(text(r.recoveredOn))) errors.recoveredOn = "must be a date YYYY-MM-DD"
  if (text(r.location).length < 2) errors.location = "must be at least 2 characters"
  if (text(r.condition).length < 3) errors.condition = "must be at least 3 characters"
  let meterReading: StaffRecoveryInput["meterReading"]
  if (r.meterReading !== undefined && r.meterReading !== null) {
    const m = record(r.meterReading)
    const date = m?.readingDate === undefined ? undefined : text(m.readingDate)
    if (!m || !Number.isSafeInteger(m.value) || (date !== undefined && !ISO_DAY.test(date))) errors.meterReading = "needs a whole-number value and an optional readingDate YYYY-MM-DD"
    else meterReading = { value: m.value as number, readingDate: date }
  }
  if (Object.keys(errors).length > 0) return { errors }
  return { data: {
    route: r.route as RecoveryRoute, recoveredOn: text(r.recoveredOn), location: text(r.location), condition: text(r.condition),
    surrenderRequestId: optionalId(r.surrenderRequestId), legalMatterId: optionalId(r.legalMatterId), meterReading,
  } }
}

/** The body of a recovery cost; amounts are integer cents. */
export function parseCost(body: unknown): Parsed<RecoveryCostInput> {
  const r = record(body)
  if (!r) return { errors: { body: "must be a JSON object" } }
  const errors: Record<string, string> = {}
  if (!COST_TYPES.includes(r.type as RecoveryCostType)) errors.type = `must be one of ${COST_TYPES.join(", ")}`
  if (!TREATMENTS.includes(r.treatment as RecoveryCostTreatment)) errors.treatment = `must be one of ${TREATMENTS.join(", ")}`
  if (!Number.isSafeInteger(r.netCents) || (r.netCents as number) < 0) errors.netCents = "must be non-negative whole cents"
  if (!Number.isSafeInteger(r.vatCents) || (r.vatCents as number) < 0) errors.vatCents = "must be non-negative whole cents"
  if (!text(r.supplierInvoiceRef)) errors.supplierInvoiceRef = "is required"
  if (!ISO_DAY.test(text(r.incurredOn))) errors.incurredOn = "must be a date YYYY-MM-DD"
  if (Object.keys(errors).length > 0) return { errors }
  return { data: {
    type: r.type as RecoveryCostType, treatment: r.treatment as RecoveryCostTreatment, netCents: r.netCents as number, vatCents: r.vatCents as number,
    supplierId: optionalId(r.supplierId), supplierInvoiceRef: text(r.supplierInvoiceRef), incurredOn: text(r.incurredOn),
    legalStepId: optionalId(r.legalStepId), note: typeof r.note === "string" ? r.note : null,
  } }
}

/** The body of a cost decision. */
export function parseCostDecision(body: unknown): Parsed<{ decision: "APPROVED" | "REJECTED" }> {
  const r = record(body)
  if (r?.decision !== "APPROVED" && r?.decision !== "REJECTED") return { errors: { decision: "must be APPROVED or REJECTED" } }
  return { data: { decision: r.decision } }
}
