/**
 * The lender's own bank statement (ABSA CSV export: Date, Description, Amount,
 * Balance), imported weekly on Payments → Bank reconciliation the way staff do
 * it: the StatementUpload form calls the `uploadStatementAction` Server
 * Action, then each line is reconciled from the review queue: a line the
 * matcher proposed for the right loan is confirmed (`confirmMatchAction`); a
 * line it left unmatched, or proposed for another loan, is assigned to the
 * right loan (`reassignMatchAction`, the queue's loan picker).
 *
 * EFT repayments appear as credits naming the payer's bank, account number
 * and name (the persona's real-looking banking details), with or without the
 * loan reference — the matcher's EXACT and HEURISTIC tiers respectively. A
 * bank fee debit keeps it looking like a statement rather than a list of
 * repayments; it stays in the queue, as a debit does in a real one.
 *
 * Bank sync is switched on in servicing/setup.ts (Settings → Bank Statement
 * Import), so a refused upload is a failure, not a fallback.
 */
import type { UploadStatementResult } from "../../../app/(dashboard)/payments/bank-reconciliation/actions"
import { bankDef } from "../personas/catalog"
import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { statementLines } from "./loan-read"
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

export interface ImportOutcome {
  lines: number
  /** Proposed for the right loan; confirmed. */
  confirmed: number
  /** Unmatched or proposed for another loan; assigned to the right one. */
  assigned: number
  /** Already reconciled (a re-upload after --resume). */
  alreadyMatched: number
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
  const result = await callFormAction<UploadStatementResult>(officer, "uploadStatementAction", PAGE, form)
  if (!result.ok) throw new Error(`statement ${importDay} refused: ${result.error}`)
  log(`statement ${importDay}: ${result.lineCount} lines, ${result.newTxnCount} new, ${result.autoApplied} auto-applied${result.deduplicated ? " (already imported)" : ""}`)

  const lines = await statementLines(result.importId)
  const outcome: ImportOutcome = { lines: lines.length, confirmed: 0, assigned: 0, alreadyMatched: 0 }
  for (const c of credits) {
    const description = describe(c)
    const line = lines.find((l) => l.description === description && l.amountCents === c.amountCents && l.postedDay === c.day)
    if (!line) throw new Error(`statement ${importDay}: no imported line "${description}" ${money(c.amountCents)} on ${c.day}`)
    if (line.matchStatus === "MATCHED" && line.matchedLoanId === c.loanId) {
      outcome.alreadyMatched++
    } else if (line.matchStatus === "PROPOSED" && line.matchedLoanId === c.loanId) {
      await callAction<undefined>(officer, "confirmMatchAction", PAGE, [line.txnId, c.loanId])
      outcome.confirmed++
    } else if (line.matchStatus === "PROPOSED" || line.matchStatus === "UNMATCHED") {
      await callAction<undefined>(officer, "reassignMatchAction", PAGE, [line.txnId, c.loanId])
      outcome.assigned++
    } else {
      throw new Error(`statement ${importDay}: line ${line.txnId} is ${line.matchStatus} (loan ${line.matchedLoanId ?? "none"}), not open for ${c.loanRef}`)
    }
  }
  return outcome
}
