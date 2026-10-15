import type { RecoveryCostTreatment, RecoveryCostType } from "@prisma/client"
import { randsToCents } from "@/lib/asset-finance/money-input"

// The one place that knows how a recovery cost is entered and decided. A cost
// is recorded PENDING by a manager (POST .../costs); a different person with
// decide_asset_finance then approves or rejects it (POST .../costs/[costId]/decide).
// Only approved costs count in the proceeds and the notices. If entry changes
// shape again, change this file and the forms' `COST_ENTRY` flags.

export const COST_ENTRY = {
  submitLabel: "Record cost",
  /** Who may enter a cost. */
  canEnter: (perms: { canManage: boolean }): boolean => perms.canManage,
  /** Who may decide one, given who recorded it: a different person than its recorder. */
  canDecide: (perms: { canDecide: boolean }, recordedById: string, userId: string): boolean => perms.canDecide && recordedById !== userId,
  entryHint: "A cost is decided by someone other than the person who recorded it; only approved costs count in the proceeds and on the notices.",
} as const

export interface CostForm {
  type: RecoveryCostType
  treatment: RecoveryCostTreatment
  net: string
  vat: string
  supplierId: string
  supplierInvoiceRef: string
  incurredOn: string
  legalStepId: string
  note: string
}

export const emptyCostForm = (today: string, type: RecoveryCostType, treatment: RecoveryCostTreatment): CostForm => ({
  type, treatment, net: "", vat: "0", supplierId: "", supplierInvoiceRef: "", incurredOn: today, legalStepId: "", note: "",
})

export type CostSubmission = { error: string } | { url: string; body: Record<string, unknown> }

/** The request for a cost, or what is wrong with the form; the route and the database check the rest. */
export function costSubmission(recoveryId: string, form: CostForm): CostSubmission {
  const netCents = randsToCents(form.net)
  const vatCents = randsToCents(form.vat === "" ? "0" : form.vat)
  if (netCents === null) return { error: "Enter the net amount in rand, e.g. 1250.00" }
  if (vatCents === null) return { error: "Enter the VAT in rand (0 when the supplier is not a VAT vendor)" }
  if (netCents + vatCents <= 0) return { error: "The cost must be more than nil" }
  if (!form.supplierInvoiceRef.trim()) return { error: "Enter the supplier's invoice reference" }
  if (!form.incurredOn) return { error: "Choose the date the cost was incurred" }
  if (form.type === "LEGAL_TAXED" && !form.legalStepId) return { error: "A taxed legal cost names the judgment or settlement step it follows" }
  return {
    url: `/api/asset-finance/recoveries/${recoveryId}/costs`,
    body: {
      type: form.type, treatment: form.treatment, netCents, vatCents, supplierInvoiceRef: form.supplierInvoiceRef.trim(), incurredOn: form.incurredOn,
      ...(form.supplierId ? { supplierId: form.supplierId } : {}),
      ...(form.legalStepId ? { legalStepId: form.legalStepId } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    },
  }
}

export type CostDecision = "APPROVED" | "REJECTED"

export const costDecisionSubmission = (recoveryId: string, costId: string, decision: CostDecision) =>
  ({ url: `/api/asset-finance/recoveries/${recoveryId}/costs/${costId}/decide`, body: { decision } })
