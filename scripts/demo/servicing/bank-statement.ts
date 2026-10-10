/**
 * The lender's own bank statement (ABSA CSV export: Date, Description, Amount,
 * Balance), imported weekly on Payments → Bank reconciliation the way staff do
 * it: the StatementUpload form calls the `uploadStatementAction` Server
 * Action, then each proposed match is confirmed with `confirmMatchAction`.
 *
 * EFT repayments appear as credits naming the payer's bank, account number
 * and name (the persona's real-looking banking details), with or without the
 * loan reference — the matcher's EXACT and HEURISTIC tiers respectively. A
 * bank fee debit keeps it looking like a statement rather than a list of
 * repayments.
 *
 * If the product refuses the import (TenantConfig.bankSyncEnabled is off and
 * no Settings screen or API turns it on), staff fall back to what they do
 * without bank sync: capture each EFT credit from the statement by hand,
 * value-dated to the statement line. The refusal is logged, not hidden.
 */
import { bankDef } from "../personas/catalog"
import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { proposedMatches } from "./loan-read"
import { recordReceipt } from "./payments"
import { callAction, callFormAction } from "./server-action"

const PAGE = "/payments/bank-reconciliation"

export interface EftCredit {
  /** YYYY-MM-DD the money landed. */
  day: string
  persona: Persona
  loanId: string
  loanRef: string
  amountCents: number
  /** Whether the client typed the loan reference into their EFT. */
  withReference: boolean
  eventId: string
}

type UploadResult =
  | { ok: true; importId: string; lineCount: number; newTxnCount: number; autoApplied: number; deduplicated: boolean }
  | { ok: false; error: string }

const BANK_SYNC_DISABLED = "Bank sync is not enabled for this tenant."

export interface ImportOutcome {
  imported: boolean
  confirmed: number
  capturedByHand: number
  leftForReview: number
}

function describe(c: EftCredit): string {
  const bank = bankDef(c.persona.bank.bankCode).displayName.toUpperCase()
  const name = `${c.persona.firstName.charAt(0)} ${c.persona.lastName}`.toUpperCase()
  return c.withReference
    ? `ACB CREDIT ${bank} ${c.persona.bank.accountNumber} ${name} ${c.loanRef}`
    : `DIGITAL TRANSF CR ${c.persona.bank.accountNumber} ${bank} ${c.persona.firstName.toUpperCase()} ${c.persona.lastName.toUpperCase()}`
}

const money = (cents: number): string => (cents / 100).toFixed(2)

/** Builds the CSV; returns it with the closing balance. */
export function statementCsv(credits: EftCredit[], importDay: string, openingCents: number): { csv: string; closingCents: number } {
  const lines = [...credits]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((c) => ({ day: c.day, description: describe(c), amount: c.amountCents }))
  lines.push({ day: importDay, description: "SERVICE FEE MONTHLY ACC FEE HEADOFFICE", amount: -18_500 })
  let balance = openingCents
  const rows = lines.map((l) => {
    balance += l.amount
    return `${l.day.replace(/-/g, "")},"${l.description}",${money(l.amount)},${money(balance)}`
  })
  return { csv: ["Date,Description,Amount,Balance", ...rows].join("\n") + "\n", closingCents: balance }
}

export async function importStatement(
  officer: SimClient,
  credits: EftCredit[],
  importDay: string,
  csv: string,
): Promise<ImportOutcome> {
  const form = new FormData()
  form.set("file", new File([csv], `absa-statement-${importDay}.csv`, { type: "text/csv" }))
  const result = await callFormAction<UploadResult>(officer, "uploadStatementAction", PAGE, form)
  const outcome: ImportOutcome = { imported: false, confirmed: 0, capturedByHand: 0, leftForReview: 0 }

  if (!result.ok) {
    if (result.error !== BANK_SYNC_DISABLED) throw new Error(`statement ${importDay} refused: ${result.error}`)
    log(`statement ${importDay}: import refused ("${result.error}"); capturing ${credits.length} EFT credit(s) by hand`)
    for (const c of credits) {
      await recordReceipt(officer, {
        loanId: c.loanId,
        amountCents: c.amountCents,
        method: "EFT",
        reference: describe(c).slice(0, 80),
        notes: `Captured from bank statement of ${importDay}`,
        receivedDay: c.day < importDay ? c.day : undefined,
        idempotencyKey: `sim-eft-${c.eventId}`,
      })
      outcome.capturedByHand++
    }
    return outcome
  }

  outcome.imported = true
  log(`statement ${importDay}: ${result.lineCount} lines, ${result.newTxnCount} new, ${result.autoApplied} auto-applied`)
  const proposals = await proposedMatches(result.importId)
  for (const c of credits) {
    const hit = proposals.find((m) => m.loanId === c.loanId && m.amountCents === c.amountCents && m.postedDay === c.day)
    if (!hit) {
      outcome.leftForReview++
      continue
    }
    await callAction<undefined>(officer, "confirmMatchAction", PAGE, [hit.txnId, hit.loanId])
    proposals.splice(proposals.indexOf(hit), 1)
    outcome.confirmed++
  }
  if (outcome.leftForReview > 0) log(`statement ${importDay}: ${outcome.leftForReview} credit(s) left in the review queue`)
  return outcome
}
