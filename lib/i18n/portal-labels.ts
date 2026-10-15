import { formatStatusLabel } from "@/lib/status-style"
import { portalLoanStatusLabel } from "@/lib/portal/loan-overview"
import { isBalanceWaiver } from "@/lib/payments/waiver"
import { portalLabels } from "./messages/en/portal-labels"
import type { MessageKey, Translator } from "./translate"

type LabelKey = MessageKey<"portalLabels">
type Labels = Translator<"portalLabels">

// Enum values arrive as strings at runtime; one not in the catalogue falls back
// to the English helper the portal used before, rather than throwing.
const LABEL_KEYS: ReadonlySet<string> = new Set(Object.keys(portalLabels))
const isLabelKey = (key: string): key is LabelKey => LABEL_KEYS.has(key)

/** An enum status (loan, application, schedule, policy, claim) as a badge label. */
export function statusLabel(t: Labels, status: string): string {
  const key = `status_${status}`
  return isLabelKey(key) ? t(key) : formatStatusLabel(status)
}

const LOAN_TITLES: Record<string, LabelKey> = {
  COMPLETED: "loanPaidUp",
  DEFAULTED: "loanDefaulted",
  PENDING_WRITE_OFF: "loanPendingWriteOff",
  WRITTEN_OFF: "loanWrittenOff",
  RESTRUCTURED: "loanRestructured",
  CANCELLED: "loanCancelled",
}

/** portalLoanStatusLabel, translated. */
export function loanStatusTitle(t: Labels, status: string, hasArrears: boolean): string {
  if (status === "ACTIVE") return t(hasArrears ? "loanInArrears" : "loanGoodStanding")
  const key = LOAN_TITLES[status]
  return key ? t(key) : portalLoanStatusLabel(status, hasArrears)
}

/** The portal's payment-method wording ("eft", "debit order", "Balance waived"), translated. */
export function paymentMethodLabel(t: Labels, method: string): string {
  if (isBalanceWaiver(method)) return t("methodWaived")
  const key = `method_${method}`
  return isLabelKey(key) ? t(key) : method.toLowerCase().replace("_", " ")
}

/** A document type's name, or the raw type when the catalogue has none. */
export function docTypeLabel(t: Labels, docType: string): string {
  const key = `doc_${docType}`
  return isLabelKey(key) ? t(key) : docType
}
