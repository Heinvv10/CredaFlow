import type { EntityDocumentType } from "@prisma/client"
import { parseEntityDocumentForm, type ParsedEntityUpload } from "./entity-document-io"
import { parseBankAccountRequest, type BankAccountFields } from "./supplier-input"

/** What bank confirmation may evidence a surplus refund's account: the bank's letter or a statement. */
export const REFUND_EVIDENCE_TYPES: readonly EntityDocumentType[] = ["BANK_STATEMENT", "OTHER"]

export type ParsedRefundForm = { ok: true; bank: BankAccountFields; upload: ParsedEntityUpload } | { ok: false; error: string }

/**
 * The multipart body of a refund: accountHolder, bankName, branchCode,
 * accountNumber, plus the verification evidence as `file` and `docType`
 * (BANK_STATEMENT or OTHER). The account is checked like a supplier's
 * (6-digit branch code, 6 to 16 digit account number).
 */
export async function parseRefundForm(req: Request): Promise<ParsedRefundForm> {
  const upload = await parseEntityDocumentForm(req.clone(), REFUND_EVIDENCE_TYPES, { allowDeal: false })
  if ("error" in upload) return { ok: false, error: upload.error }
  const form = await req.formData()
  const text = (key: string) => form.get(key)
  const bank = parseBankAccountRequest({ accountHolder: text("accountHolder"), bankName: text("bankName"), branchCode: text("branchCode"), accountNumber: text("accountNumber") })
  if ("errors" in bank) return { ok: false, error: Object.entries(bank.errors).map(([key, message]) => `${key} ${message}`).join("; ") }
  return { ok: true, bank: bank.data, upload: upload.upload }
}
