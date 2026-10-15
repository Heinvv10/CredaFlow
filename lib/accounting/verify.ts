/**
 * The balance proof a batch must pass before it is stored. The database
 * repeats it when the batch closes (guardAccountingBatch); this one refuses
 * early with a reason a person can act on.
 */
import type { DerivedEntry } from "./derive"

export class UnbalancedJournalError extends Error {
  constructor(readonly eventKey: string | null, message: string) {
    super(message)
    this.name = "UnbalancedJournalError"
  }
}

export interface BatchTotals {
  entryCount: number
  lineCount: number
  debitCents: bigint
  creditCents: bigint
}

export function verifyBalanced(entries: DerivedEntry[]): BatchTotals {
  let debit = BigInt(0)
  let credit = BigInt(0)
  let lines = 0
  for (const entry of entries) {
    let entryDebit = 0
    let entryCredit = 0
    if (entry.lines.length < 2) {
      throw new UnbalancedJournalError(entry.eventKey, `${entry.eventKey}: a journal entry needs at least one debit and one credit`)
    }
    for (const line of entry.lines) {
      const oneSided = (line.debitCents > 0) !== (line.creditCents > 0)
      if (!Number.isSafeInteger(line.debitCents) || !Number.isSafeInteger(line.creditCents) || line.debitCents < 0 || line.creditCents < 0 || !oneSided) {
        throw new UnbalancedJournalError(entry.eventKey, `${entry.eventKey}: line ${line.role} must be a whole positive debit or credit`)
      }
      entryDebit += line.debitCents
      entryCredit += line.creditCents
    }
    if (entryDebit !== entryCredit) {
      throw new UnbalancedJournalError(entry.eventKey, `${entry.eventKey}: debits ${entryDebit} != credits ${entryCredit}`)
    }
    debit += BigInt(entryDebit)
    credit += BigInt(entryCredit)
    lines += entry.lines.length
  }
  if (debit !== credit) {
    throw new UnbalancedJournalError(null, `Batch does not balance: debits ${debit} != credits ${credit}`)
  }
  return { entryCount: entries.length, lineCount: lines, debitCents: debit, creditCents: credit }
}
