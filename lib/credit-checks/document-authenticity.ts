/**
 * DOCUMENT_AUTHENTICITY: is the statement the file the bank produced, about
 * this client, and recent? Each code is one observable fact about the file;
 * none is a finding of fraud — the officer decides.
 *
 * The balance codes fire on TEXT reads only. A vision read that fails the
 * arithmetic goes to MANUAL_REVIEW/UNVERIFIED_READ instead (manual-review.ts),
 * because there a misread and a forgery look the same.
 */
import { areNamesSimilar } from "@/lib/ocr/name-matching"
import { checkBalance } from "@/lib/statement-analysis/balance-check"
import { formatCents } from "@/lib/statement-analysis/money"
import {
  EXPECTED_PRODUCERS,
  MODIFIED_AFTER_CREATION_TOLERANCE_MS,
  STALE_STATEMENT_DAYS,
} from "./policy"
import { statementKey, type ApplicationFacts, type FlagCandidate, type StatementFacts } from "./types"
import { addDays } from "./dates"

function flag(s: StatementFacts, code: string, summary: string, evidence: Record<string, unknown> = {}): FlagCandidate {
  return {
    check: "DOCUMENT_AUTHENTICITY",
    code,
    key: statementKey(s),
    summary,
    evidence: { documentId: s.documentId, ...evidence },
  }
}

function producerExpected(bank: string, producer: string | null, creator: string | null): boolean {
  const expected = EXPECTED_PRODUCERS[bank]
  if (!expected) return true
  // "" means the bank writes none: the value must be absent, not merely start with nothing.
  const starts = (value: string | null, allowed: string[]) => allowed.some((p) => (p === "" ? !value : (value ?? "").startsWith(p)))
  return starts(producer, expected.producer) && starts(creator, expected.creator)
}

function checkStatement(s: StatementFacts, f: ApplicationFacts): FlagCandidate[] {
  const out: FlagCandidate[] = []
  const a = s.authenticity
  const read = s.read

  if (s.method === "TEXT" && read) {
    const balance = checkBalance(read)
    if (balance.diffCents !== null && balance.result === "FAIL" && Math.abs(balance.diffCents) > 1) {
      out.push(flag(s, "BALANCE_MISMATCH",
        `Opening balance plus the listed transactions is ${formatCents(balance.diffCents)} away from the closing balance printed on the statement.`,
        { diffCents: balance.diffCents }))
    }
    if (balance.breaks.length > 0) {
      const rows = balance.breaks.slice(0, 20)
      out.push(flag(s, "RUNNING_BALANCE_BREAK",
        `${balance.breaks.length} row${balance.breaks.length === 1 ? "" : "s"} where the printed balance does not follow from the previous balance and the amount.`,
        { transactionIndexes: rows, pages: [...new Set(rows.map((i) => read.transactions[i].page))] }))
    }
  }

  if (a && a.incrementalUpdates > 0) {
    out.push(flag(s, "INCREMENTAL_UPDATE",
      `The PDF was saved ${a.incrementalUpdates} more time${a.incrementalUpdates === 1 ? "" : "s"} after it was first written; edits are usually saved this way.`,
      { incrementalUpdates: a.incrementalUpdates }))
  }
  // A scan has no bank producer to compare: the scanner wrote that file.
  if (a && s.bank && !a.signals.includes("TEXT_LAYER_ABSENT") && !producerExpected(s.bank, a.producer, a.creator)) {
    out.push(flag(s, "PRODUCER_UNEXPECTED",
      `The PDF was written by "${(a.producer ?? a.creator ?? "an unnamed program").slice(0, 80)}", not the program ${s.bank} statements come from.`,
      { producer: a.producer?.slice(0, 200) ?? null, creator: a.creator?.slice(0, 200) ?? null, bank: s.bank }))
  }
  if (a?.createdAt && a.modifiedAt) {
    const gap = Date.parse(a.modifiedAt) - Date.parse(a.createdAt)
    if (gap > MODIFIED_AFTER_CREATION_TOLERANCE_MS) {
      out.push(flag(s, "MODIFIED_AFTER_CREATION",
        "The PDF records a modification after it was created.",
        { createdAt: a.createdAt, modifiedAt: a.modifiedAt }))
    }
  }
  if (read?.accountHolderName && f.clientName && !areNamesSimilar(read.accountHolderName, f.clientName)) {
    out.push(flag(s, "HOLDER_NAME_MISMATCH",
      "The account holder printed on the statement does not match the client's name.",
      { accountHolderName: read.accountHolderName }))
  }
  if (read?.periodEnd && read.periodEnd < addDays(f.applicationDate, -STALE_STATEMENT_DAYS)) {
    out.push(flag(s, "STALE_STATEMENT",
      `The statement ends on ${read.periodEnd}, more than ${STALE_STATEMENT_DAYS} days before the application.`,
      { periodEnd: read.periodEnd }))
  }
  return out
}

export function documentAuthenticity(f: ApplicationFacts): FlagCandidate[] {
  return f.statements.filter((s) => s.state === "READ" || s.authenticity).flatMap((s) => checkStatement(s, f))
}
