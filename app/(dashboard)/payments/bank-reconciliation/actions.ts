"use server"

import { auth } from "@/lib/auth"
import { canDo } from "@/lib/auth-guards"
import { applyBankTransaction, ignoreBankTransaction } from "@/lib/bank-sync/apply"
import {
  importStatement,
  BankSyncDisabledError,
  StatementParseError,
  MAX_STATEMENT_BYTES,
} from "@/lib/bank-sync/import"
import { revalidatePath } from "next/cache"

async function ctx() {
  const session = await auth()
  if (!session?.user || !canDo(session.user.role, "record_payment") || !canDo(session.user.role, "view_loan_book")) {
    throw new Error("Insufficient permissions")
  }
  // The staff session's tenant, never the deployment default; no tenant, no access.
  const tenantId = session.user.tenantId
  if (!tenantId) throw new Error("Insufficient permissions")
  return { tenantId, userId: session.user.id, userEmail: session.user.email }
}

export async function confirmMatchAction(txnId: string, loanId: string) {
  const c = await ctx()
  await applyBankTransaction({ txnId, loanId, ...c })
  revalidatePath("/payments/bank-reconciliation")
}

export async function reassignMatchAction(txnId: string, loanId: string) {
  return confirmMatchAction(txnId, loanId)
}

export async function ignoreMatchAction(txnId: string, reason: string) {
  const c = await ctx()
  await ignoreBankTransaction({ txnId, reason, ...c })
  revalidatePath("/payments/bank-reconciliation")
}

export type UploadStatementResult =
  | { ok: true; importId: string; lineCount: number; newTxnCount: number; autoApplied: number; deduplicated: boolean }
  | { ok: false; error: string }

/**
 * Staff manual upload of an ABSA statement CSV.
 *
 * The same pipeline the worker's secret-guarded endpoint uses
 * (lib/bank-sync/import.ts) — this only swaps the authentication (staff session
 * + `record_payment`, matching every other write on this page) and the audit
 * actor. Re-uploading the same file is a no-op: importStatement dedups on the
 * file's sha256.
 *
 * Expected, user-caused problems (no file, too big, unparseable, flag off) come
 * back as `{ok:false}` for the UI to render. Anything else rethrows: a friendly
 * message over an unexpected fault would hide a real bug.
 */
export async function uploadStatementAction(formData: FormData): Promise<UploadStatementResult> {
  const c = await ctx()

  const file = formData.get("file")
  if (!(file instanceof File)) return { ok: false, error: "Choose a CSV file to upload." }
  // This is NOT what stops an oversized body — by the time a Server Action runs,
  // Next has already streamed and parsed the whole multipart into FormData, and
  // its own serverActions.bodySizeLimit (next.config.ts) has already aborted
  // anything past the ceiling. Keep the two numbers equal: this check exists to
  // give a readable error instead of an opaque framework 413, and skipping the
  // arrayBuffer() copy is a side benefit, not the point.
  if (file.size > MAX_STATEMENT_BYTES) return { ok: false, error: "That file is too large (max 5MB)." }
  if (file.size === 0) return { ok: false, error: "That file is empty." }

  const raw = Buffer.from(await file.arrayBuffer()).toString("utf-8")

  try {
    const result = await importStatement({
      tenantId: c.tenantId,
      raw,
      contentType: file.type,
      // The worker knows the account + window it downloaded; a human uploading a
      // file does not, and inventing values here would put guesses in an audited
      // record. The statement's own dates are on the parsed lines.
      accountRef: "",
      format: "CSV",
      periodStart: null,
      periodEnd: null,
      actorEmail: c.userEmail,
    })
    revalidatePath("/payments/bank-reconciliation")
    return { ok: true, ...result }
  } catch (e) {
    if (e instanceof StatementParseError) return { ok: false, error: e.message }
    if (e instanceof BankSyncDisabledError) return { ok: false, error: "Bank sync is not enabled for this tenant." }
    throw e
  }
}
