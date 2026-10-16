/**
 * The one IsaFlow draft journal a closed month becomes, built once and stored
 * (AccountingIsaFlowPush.requestJson) so every retry sends the same bytes
 * under the same idempotency key, and the read-back that recognises it.
 *
 * IsaFlow has no external reference on journals (spec §1.2), so the batch is
 * named in the memo, `[credaflow:<batchId>]`, and a draft found on read-back
 * counts only if it also carries exactly the lines that were sent.
 */
import { createHash } from "node:crypto"
import { IsaFlowError } from "./client"
import type { StoredLine } from "../csv"
import type { GlAccountRow, JournalListEntry } from "./contract"

export const isaflowIdempotencyKey = (batchId: string) => `credaflow:batch:${batchId}`
export const isaflowMemoTag = (batchId: string) => `[credaflow:${batchId}]`

export interface DraftLine {
  code: string
  debitCents: number
  creditCents: number
}

/** Whole cents as rands with at most two decimals (IsaFlow's amounts are numeric(15,2) rands). */
export function randsAmount(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`not a whole, non-negative cent amount: ${cents}`)
  return Number((cents / 100).toFixed(2))
}

/** One line per account code: its net movement for the month, on its side. Codes that did not move are dropped. */
export function netByAccount(lines: StoredLine[]): DraftLine[] {
  const net = new Map<string, number>()
  for (const l of lines) net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents)
  return [...net.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, cents]) => ({ code, debitCents: Math.max(cents, 0), creditCents: Math.max(-cents, 0) }))
}

export type ChartCheck = { ok: true; ids: Map<string, string> } | { ok: false; missing: string[]; inactive: string[]; ambiguous: string[] }

/** Each code must exist exactly once in the IsaFlow chart and be active. */
export function resolveChart(codes: string[], chart: GlAccountRow[]): ChartCheck {
  const ids = new Map<string, string>()
  const missing: string[] = [], inactive: string[] = [], ambiguous: string[] = []
  for (const code of [...new Set(codes)].sort()) {
    const rows = chart.filter((a) => a.account_code === code)
    if (rows.length === 0) missing.push(code)
    else if (rows.length > 1) ambiguous.push(code)
    else if (!rows[0].is_active) inactive.push(code)
    else ids.set(code, rows[0].id)
  }
  return missing.length + inactive.length + ambiguous.length === 0 ? { ok: true, ids } : { ok: false, missing, inactive, ambiguous }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The create_draft_journal arguments, as the exact text that is stored and sent. */
export function buildDraftJournal(args: {
  batchId: string
  label: string
  date: string
  companyId: string
  lines: DraftLine[]
  accountIds: Map<string, string>
}): { argsJson: string; sha256: string } {
  if (args.lines.length === 0) throw new IsaFlowError("definite", "This month moved no account; there is nothing to push")
  const debit = args.lines.reduce((s, l) => s + l.debitCents, 0)
  const credit = args.lines.reduce((s, l) => s + l.creditCents, 0)
  if (debit !== credit) throw new IsaFlowError("definite", `The month's journal does not balance (${debit} / ${credit} cents)`)
  const request = {
    date: args.date,
    memo: `CredaFlow journals ${args.label} ${isaflowMemoTag(args.batchId)}`,
    lines: args.lines.map((l) => {
      const id = args.accountIds.get(l.code)
      if (!id) throw new IsaFlowError("definite", `Account ${l.code} has no IsaFlow account id`)
      return { account_id: id, debit: randsAmount(l.debitCents), credit: randsAmount(l.creditCents), description: `CredaFlow ${l.code}` }
    }),
    idempotency_key: isaflowIdempotencyKey(args.batchId),
    company_id: args.companyId,
  }
  const argsJson = JSON.stringify(request)
  return { argsJson, sha256: sha256Hex(argsJson) }
}

type Leg = string
const toCents = (rands: number) => Math.round(rands * 100)
const legs = (lines: Array<{ accountId: string; debitCents: number; creditCents: number }>): Leg[] =>
  lines.map((l) => `${l.accountId}|${l.debitCents}|${l.creditCents}`).sort()

/**
 * The draft this request created, if IsaFlow holds it: dated the same day
 * (the caller lists that day), carrying the batch's memo tag and exactly the
 * same lines. A draft with the tag but other lines is `conflicting`: somebody
 * edited it, or it is not ours; a person must look.
 */
export function findPushedDraft(entries: JournalListEntry[], argsJson: string): { found: JournalListEntry | null; conflicting: JournalListEntry | null } {
  const sent = JSON.parse(argsJson) as { memo: string; lines: Array<{ account_id: string; debit: number; credit: number }> }
  const tag = /\[credaflow:[^\]]+\]/.exec(sent.memo)?.[0]
  if (!tag) throw new Error("stored IsaFlow request has no memo tag")
  const want = legs(sent.lines.map((l) => ({ accountId: l.account_id, debitCents: toCents(l.debit), creditCents: toCents(l.credit) }))).join("\n")
  let conflicting: JournalListEntry | null = null
  for (const entry of entries) {
    if (!entry.description?.includes(tag)) continue
    const got = legs((entry.lines ?? []).map((l) => ({ accountId: l.accountId, debitCents: toCents(l.debit), creditCents: toCents(l.credit) }))).join("\n")
    if (got === want) return { found: entry, conflicting: null }
    conflicting ??= entry
  }
  return { found: null, conflicting }
}
