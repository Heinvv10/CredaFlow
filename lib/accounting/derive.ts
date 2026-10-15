/**
 * Journal entries for one period: for every source, what it should have posted
 * by the period's end minus what earlier batches posted.
 *
 * Pure. Idempotent by construction: once a period's entries are stored, the
 * same derivation finds nothing left to post for any source. A source's first
 * posting uses its base key as the event key; a later correction uses
 * `<baseKey>@<period>`, so the ledger's unique (tenantId, eventKey) means each
 * event is exported once.
 *
 * VAT: when the lender is VAT-registered, a credit (or debit) to a fee-income
 * role marked VAT-inclusive is split into the net fee and OUTPUT_VAT. The VAT
 * line keeps the fee role as its `sourceRole`, so the ledger still compares
 * the gross fee and the split never re-posts history.
 */
import { ACCOUNT_ROLES, type AccountMap, type AccountRole } from "./accounts"
import { postingDate, type AccountingPeriod } from "./period"
import { loanSources, type DesiredSource, type EventType, type SourceLoan, type Vector } from "./sources"

export interface DerivedLine {
  role: AccountRole
  /** The role the ledger compares this line under, when it differs from `role`. */
  sourceRole: AccountRole | null
  accountCode: string
  taxCode: string | null
  debitCents: number
  creditCents: number
}

export interface DerivedEntry {
  eventKey: string
  baseKey: string
  eventType: EventType
  eventDate: Date
  postingDate: string
  loanId: string | null
  reference: string
  description: string
  lines: DerivedLine[]
}

/** What earlier batches posted, per base key and role (+ debit, - credit). */
export type PostedLedger = Map<string, Vector>

export interface VatSettings {
  registered: boolean
  rateBps: number
}

export function delta(desired: Vector, posted: Vector | undefined): Vector {
  const out: Vector = {}
  for (const role of ACCOUNT_ROLES) {
    const d = (desired[role] ?? 0) - (posted?.[role] ?? 0)
    if (d !== 0) out[role] = d
  }
  return out
}

/** VAT inside a VAT-inclusive amount, rounded to the cent. */
export function vatOf(grossCents: number, rateBps: number): number {
  return Math.round((grossCents * rateBps) / (10_000 + rateBps))
}

function line(role: AccountRole, sourceRole: AccountRole | null, cents: number, accounts: AccountMap): DerivedLine {
  return {
    role, sourceRole, accountCode: accounts[role].code, taxCode: accounts[role].taxCode,
    debitCents: cents > 0 ? cents : 0, creditCents: cents < 0 ? -cents : 0,
  }
}

export function linesOf(vector: Vector, accounts: AccountMap, vat: VatSettings | null = null): DerivedLine[] {
  const debits: DerivedLine[] = []
  const credits: DerivedLine[] = []
  for (const role of ACCOUNT_ROLES) {
    const cents = vector[role] ?? 0
    if (cents === 0) continue
    const parts: DerivedLine[] = []
    if (vat?.registered && accounts[role].vatInclusive) {
      const tax = Math.sign(cents) * vatOf(Math.abs(cents), vat.rateBps)
      if (cents - tax !== 0) parts.push(line(role, null, cents - tax, accounts))
      if (tax !== 0) parts.push(line("OUTPUT_VAT", role, tax, accounts))
    } else {
      parts.push(line(role, null, cents, accounts))
    }
    for (const p of parts) (p.debitCents > 0 ? debits : credits).push(p)
  }
  return [...debits, ...credits]
}

/** Adds stored entries to a posted ledger (in place): the read side of the ledger, in memory. */
export function accumulate(posted: PostedLedger, postedKeys: Set<string>, entries: Array<Pick<DerivedEntry, "baseKey" | "lines">>): void {
  for (const entry of entries) {
    postedKeys.add(entry.baseKey)
    const vector = posted.get(entry.baseKey) ?? {}
    for (const l of entry.lines) {
      const role = l.sourceRole ?? l.role
      vector[role] = (vector[role] ?? 0) + l.debitCents - l.creditCents
    }
    posted.set(entry.baseKey, vector)
  }
}

function entryFor(source: DesiredSource, change: Vector, firstPosting: boolean, period: AccountingPeriod, accounts: AccountMap, vat: VatSettings | null): DerivedEntry {
  const movesCash = (change.BANK ?? 0) !== 0 || (change.WAIVER_EXPENSE ?? 0) !== 0
  const label = firstPosting ? source.origin : !movesCash && source.reclass ? source.reclass : source.change
  const eventDate = label.date && label.date.getTime() < period.end.getTime() ? label.date : period.start
  return {
    eventKey: firstPosting ? source.baseKey : `${source.baseKey}@${period.key}`,
    baseKey: source.baseKey,
    eventType: label.type,
    eventDate,
    postingDate: postingDate(eventDate, period),
    loanId: source.loanId,
    reference: source.reference,
    description: label.description,
    lines: linesOf(change, accounts, vat),
  }
}

/** Every source of every loan, desired as at `asOf`. */
export function desiredSources(loans: SourceLoan[], asOf: Date): DesiredSource[] {
  return loans.flatMap((loan) => loanSources(loan, asOf))
}

/**
 * Entries for `period`. `posted` is the ledger so far; `postedKeys` the base
 * keys that already have an entry (a source posted and fully reversed nets to
 * zero but must not reuse its first event key). Sources the ledger knows but
 * the loans no longer produce (a default charge removed by a re-derivation)
 * are reversed through their stored vector.
 */
export function deriveEntries(args: {
  loans: SourceLoan[]
  period: AccountingPeriod
  posted: PostedLedger
  postedKeys: Set<string>
  /** Loan of each base key in the ledger, for sources that no longer exist. */
  postedLoans: Map<string, { loanId: string | null; reference: string }>
  accounts: AccountMap
  vat?: VatSettings | null
}): DerivedEntry[] {
  const { period, posted, postedKeys, accounts } = args
  const vat = args.vat ?? null
  const entries: DerivedEntry[] = []
  const seen = new Set<string>()
  for (const source of desiredSources(args.loans, period.end)) {
    seen.add(source.baseKey)
    const change = delta(source.vector, posted.get(source.baseKey))
    if (Object.keys(change).length === 0) continue
    entries.push(entryFor(source, change, !postedKeys.has(source.baseKey), period, accounts, vat))
  }
  for (const [baseKey, vector] of posted) {
    if (seen.has(baseKey)) continue
    const change = delta({}, vector)
    if (Object.keys(change).length === 0) continue
    const owner = args.postedLoans.get(baseKey) ?? { loanId: null, reference: "" }
    entries.push({
      eventKey: `${baseKey}@${period.key}`,
      baseKey,
      eventType: "ADJUSTMENT",
      eventDate: period.start,
      postingDate: period.firstDay,
      loanId: owner.loanId,
      reference: owner.reference,
      description: `Removed ${baseKey.split(":")[2] ?? "item"} reversed on ${owner.reference}`.trim(),
      lines: linesOf(change, accounts, vat),
    })
  }
  return entries.sort((a, b) =>
    a.postingDate < b.postingDate ? -1 : a.postingDate > b.postingDate ? 1 : a.eventKey < b.eventKey ? -1 : a.eventKey > b.eventKey ? 1 : 0,
  )
}
