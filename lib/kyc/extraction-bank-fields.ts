/**
 * The two bank fields a bank-statement extraction must NOT write blindly.
 *
 * 2026-08-27/28, production: one client's bank statement was verified and then
 * invalidated five times, and a disbursement was blocked, because each re-apply
 * of the same document wrote back two values that were not actually new.
 * `app/api/clients/[id]/apply-extraction` un-verifies every verified statement
 * whenever the payout tuple moves — which is correct, and stays — but the tuple
 * was moving on nothing:
 *
 *   - `accountType`: the statement printed no product name, the VLM guessed
 *     CHEQUE, and a staff member had read the same statement and set SAVINGS.
 *   - `bankName`: extraction stored the name as printed ("STANDARD BANK") while
 *     the staff edit form stores the SA_BANKS code ("STANDARD_BANK"). Same
 *     bank, different string, so every round trip read as a change.
 *
 * These live here rather than inside the route because the route is already
 * long, and because a value written on one path and compared on another needs
 * one shared definition of "the same".
 */
import type { BankAccountType } from "@prisma/client"
import { toBankCode } from "@/lib/banks"

/**
 * Whether a statement names the bank the record already holds — and if not,
 * what to write.
 *
 * Canonicalising only the EXTRACTED side was half a fix. A staging client
 * stores the LABEL "First National Bank", the
 * statement prints the same words, and comparing the canonicalised "FNB"
 * against the raw stored label still read as a bank change: 409 "decision
 * evidence is bound to bankName". Production stores the same spread — CAPITEC
 * (18) and Capitec (5), Capitec Bank Limited (2), Capitec Bank, capitec,
 * Standard Bank, Discovery Bank, African Bank — much of it on clients with
 * verified statements, so every one of those re-applies would invalidate one.
 *
 * Same bank writes NOTHING, rather than writing the canonical code. Rewriting
 * "First National Bank" to "FNB" would move the payout tuple and invalidate the
 * statement exactly once more — the failure, spent on tidying a string. The
 * record keeps its own spelling; `toBankCode` already reads every one of them.
 *
 * Different banks, or a spelling neither side can resolve, fall through to the
 * previous behaviour: the statement corrects the record, and the invalidation
 * that follows is the correct response to a real change.
 */
export function resolveExtractedBankName(input: {
  extracted: string | undefined
  record: string | null
}): { apply: string | undefined } {
  const { extracted, record } = input
  if (extracted === undefined) return { apply: undefined }
  if (!record?.trim()) return { apply: storedBankName(extracted) }
  const recordCode = toBankCode(record)
  if (recordCode !== null && recordCode === toBankCode(extracted)) {
    return { apply: undefined }
  }
  return { apply: storedBankName(extracted) }
}

/**
 * The form the staff edit path stores a bank in.
 *
 * `components/clients/ClientFormLegacy.tsx` submits the SA_BANKS `code`, so
 * that is the vocabulary the record speaks and the one extraction must join.
 * A bank outside SA_BANKS has no code: it is kept exactly as printed, because
 * inventing a key would put a value in the record that no picker can select and
 * no canonicaliser knows. Two spellings of an unlisted bank still fail to match
 * each other — that is the pre-existing behaviour, and it fails closed.
 */
export function storedBankName(printed: string): string {
  return toBankCode(printed) ?? printed
}

export interface SkippedExtractionField {
  field: "accountType"
  record: BankAccountType
  extracted: BankAccountType
  reason: "record_set_by_staff"
}

/**
 * Staff-confirmed wins (Hein, 2026-08-28).
 *
 * Extraction may set `accountType` only on a record that has none. Capitec and
 * several ABSA products print no account type at all, so the model is guessing
 * from layout while a staff member who set the field has read the statement.
 * A disagreement is REPORTED rather than silently dropped, so the extraction
 * card can say the record was kept instead of showing a value that never
 * landed. Agreement is not reported: there is nothing to tell anyone.
 */
export function resolveExtractedAccountType(input: {
  extracted: BankAccountType | undefined
  record: BankAccountType | null
}): { apply: BankAccountType | undefined; skipped: SkippedExtractionField | undefined } {
  const { extracted, record } = input
  if (extracted === undefined) return { apply: undefined, skipped: undefined }
  if (record === null) return { apply: extracted, skipped: undefined }
  if (record === extracted) return { apply: undefined, skipped: undefined }
  return {
    apply: undefined,
    skipped: {
      field: "accountType",
      record,
      extracted,
      reason: "record_set_by_staff",
    },
  }
}
