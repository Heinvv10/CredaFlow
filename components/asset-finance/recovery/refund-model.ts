import type { Built } from "./recovery-forms"

// The surplus refund's form and who can take its next step. Presentation
// only: the two-person rule and the account checks are recovery-refund.ts and
// the database's (guardRecoveryRefund).

export const REFUND_DOC_LABELS = { BANK_STATEMENT: "Bank statement", OTHER: "Bank's confirmation letter" } as const
export type RefundDocType = keyof typeof REFUND_DOC_LABELS

export interface RefundForm {
  accountHolder: string
  bankName: string
  branchCode: string
  accountNumber: string
  docType: RefundDocType
  file: File | null
}

export const emptyRefundForm = (): RefundForm => ({ accountHolder: "", bankName: "", branchCode: "", accountNumber: "", docType: "BANK_STATEMENT", file: null })

/** The multipart body of POST .../recoveries/[id]/refund: the account plus the bank's verification as `file` and `docType`. */
export function refundBody(form: RefundForm): Built<FormData> {
  const digits = (value: string) => value.replace(/[\s-]/g, "")
  if (form.accountHolder.trim().length < 2) return { error: "Enter the account holder's name" }
  if (!form.bankName.trim()) return { error: "Enter the bank" }
  if (!/^\d{6}$/.test(digits(form.branchCode))) return { error: "The branch code is 6 digits" }
  if (!/^\d{6,16}$/.test(digits(form.accountNumber))) return { error: "The account number is 6 to 16 digits" }
  if (!form.file) return { error: "Attach the bank's confirmation of the account" }
  const data = new FormData()
  data.append("accountHolder", form.accountHolder.trim())
  data.append("bankName", form.bankName.trim())
  data.append("branchCode", digits(form.branchCode))
  data.append("accountNumber", digits(form.accountNumber))
  data.append("docType", form.docType)
  data.append("file", form.file)
  return { body: data }
}

export interface RefundLike { status: "PENDING_APPROVAL" | "APPROVED" | "RELEASED"; createdById: string; approvedById: string | null }

/** Create (a manager, once), approve (an approver other than the creator), release (an approver who neither created nor approved it, once approved). */
export function refundActions(refund: RefundLike | null, userId: string, perms: { canManage: boolean; canDecide: boolean }): { create: boolean; approve: boolean; release: boolean } {
  if (!refund) return { create: perms.canManage, approve: false, release: false }
  return {
    create: false,
    approve: refund.status === "PENDING_APPROVAL" && perms.canDecide && refund.createdById !== userId,
    release: refund.status === "APPROVED" && perms.canDecide && refund.approvedById !== userId && refund.createdById !== userId,
  }
}
