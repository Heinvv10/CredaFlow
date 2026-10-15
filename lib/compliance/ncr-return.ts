/**
 * NCR quarterly return — the single source for every figure on the return,
 * consumed by both `/compliance/ncr-return` and the `ncr-quarterly` Excel
 * export. Before this module those two, plus `GET /api/compliance/ncr-return`,
 * each computed the same lines differently: the page used `>= 30` DPD over an
 * ACTIVE-only book while the export used `> 30` over ACTIVE+DEFAULTED, and the
 * page's arrears line had no status filter at all. Three answers to one
 * regulated question.
 *
 * Two rules hold everything together.
 *
 * 1. ONE POPULATION FOR EVERY RATIO. The collectible book is
 *    `COLLECTIBLE_STATUSES` below, and it is the denominator for every PAR /
 *    arrears percentage.
 *    A numerator drawn from a wider population than its denominator can print
 *    a rate above 100% (the same defect audit N-06/N-07 fixed on the reports
 *    overview, which never reached this return).
 *
 * 2. PERIOD FIGURES AND POSITION FIGURES ARE NOT INTERCHANGEABLE. A line is
 *    either `PERIOD` — driven by a timestamp that falls inside the quarter, so
 *    it is reproducible for any past quarter — or `POSITION`, read from a
 *    mutable current-state column (`status`, `daysInArrears`, `arrearsAmount`,
 *    `outstandingPrincipal`, `collectionsStage`). Those columns carry no
 *    history, so a POSITION line for a closed quarter is TODAY's number, not
 *    what it was on the quarter's last day. That cannot be fixed by querying
 *    harder — the history does not exist — so the return labels it instead of
 *    pretending: `positionIsStale` tells the UI to say so. Submitting a quarter
 *    freezes the figures into the record, and `filed` reads them back — so a
 *    submitted quarter shows what was actually filed rather than a live book
 *    that has since moved.
 */

import type { Prisma } from "@prisma/client"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { prisma } from "@/lib/prisma"
import { parseNcrNumber } from "@/lib/config/identity"
import { section129SentInPeriodWhere } from "@/lib/collections/section129-reporting"
import { quarterBounds, isQuarterOpen } from "@/lib/compliance/quarters"
import {
  collectibleLoanWhere,
  collectibleParWhere,
} from "@/lib/loan/collectible-book"

// The collectible book is a property of the loan book, not of this module —
// see lib/loan/collectible-book.ts for the full rationale and the known
// PENDING_WRITE_OFF DPD staleness. Re-exported so existing importers are
// unchanged.
export { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"

export type NcrLineBasis = "PERIOD" | "POSITION"

export type NcrReturnLine = {
  key: string
  label: string
  /** null where a count is meaningless (e.g. a pure cash total). */
  count: number | null
  /** Cents. null where the line has no monetary dimension. */
  value: number | null
  basis: NcrLineBasis
  /** Share of the collectible book by value, 0–100. */
  percentOfBook?: number
  note?: string
}

export type NcrFiledSnapshot = {
  collectibleBook: { count: number; value: number }
  lines: NcrReturnLine[]
}

export type NcrReturnData = {
  quarter: string
  periodStart: Date
  /** Inclusive last instant of the quarter, for display only. */
  periodEnd: Date
  quarterOpen: boolean
  ncrNumber: string
  collectibleBook: { count: number; value: number }
  lines: NcrReturnLine[]
  submittedAt: Date | null
  submittedByName: string | null
  /**
   * The figures as filed, read back from the submission record. Null when the
   * quarter has not been submitted. When present this — not `lines` — is what
   * the return actually says: `lines` has since moved with the live book.
   */
  filed: NcrFiledSnapshot | null
  /**
   * True when POSITION lines cannot describe the quarter being reported on:
   * the quarter has closed and there are no filed figures to show instead.
   * Covers both "never submitted" and "submitted but the snapshot cannot be
   * read" — `filedSnapshotUnreadable` separates those two for the UI, because
   * the second must not be reported as "no return was filed".
   */
  positionIsStale: boolean
  /**
   * A submission exists for this quarter but its frozen figures could not be
   * read back. The return WAS filed; what it said is unrecoverable from this
   * record. Distinct from `positionIsStale` alone, which would otherwise make
   * the page claim both "Submitted" and "no return was filed for it".
   */
  filedSnapshotUnreadable: boolean
}

const collectibleWhere = collectibleLoanWhere

/** Accounts at or beyond `minDays` past due, within the collectible book. */
export const parWhere = collectibleParWhere

/** Loans whose agreement was entered into during the quarter. */
/**
 * The NCR return reports NCA credit agreements only. A NON_NCA (juristic,
 * asset-finance) agreement is not regulated by the NCA and is left out of
 * every figure, matching the NCR export sheets (app/api/reports/export).
 */
const NCA_ONLY = { ncaRegime: "NCA" } as const

export function disbursedInQuarterWhere(
  tenantId: string,
  start: Date,
  end: Date,
): Prisma.LoanWhereInput {
  // A disbursement reversed because the money never reached the borrower
  // (lib/payouts/reversal.ts) advanced no credit: not a new agreement.
  return { tenantId, startDate: { gte: start, lt: end }, disbursementReversals: { none: { status: "APPROVED" } } }
}

/**
 * Receipts that reached us during the quarter. Reversed rows are excluded
 * because the money went back; allocation status is NOT filtered, because an
 * over-payment is stored as an ALLOCATED parent plus an UNAPPLIED child and
 * cash received is the sum of both. The separate "applied" line below uses
 * ALLOCATED, so the two questions are answered by two lines instead of one
 * ambiguous number.
 */
export function receiptsInQuarterWhere(
  tenantId: string,
  start: Date,
  end: Date,
): Prisma.PaymentWhereInput {
  // Cash only: a small-balance waiver (lib/payments/waiver.ts) is a credit.
  return { tenantId, reversed: false, receivedAt: { gte: start, lt: end }, ...CASH_RECEIPTS }
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0
}

export async function getNcrReturnData(
  tenantId: string,
  quarter: string,
  now: Date = new Date(),
): Promise<NcrReturnData> {
  const { start, end } = quarterBounds(quarter)
  const quarterOpen = isQuarterOpen(quarter, now)

  const [
    tenantConfig,
    book,
    newAgreements,
    receipts,
    applied,
    writeOffs,
    section129Issued,
    arrears,
    par30,
    par60,
    par90,
    defaulted,
    attorneyReferrals,
    submittedRecords,
  ] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { ncrNumber: true } }),
    prisma.loan.aggregate({
      where: { ...collectibleWhere(tenantId), ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { ...disbursedInQuarterWhere(tenantId, start, end), ...NCA_ONLY },
      _count: true,
      _sum: { principal: true },
    }),
    prisma.payment.aggregate({
      where: { ...receiptsInQuarterWhere(tenantId, start, end), loan: NCA_ONLY },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...receiptsInQuarterWhere(tenantId, start, end), allocationStatus: "ALLOCATED", loan: NCA_ONLY },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.loan.aggregate({
      // `writeOffAt` alone, deliberately. Adding `status: "WRITTEN_OFF"` is what
      // made this line non-reproducible: any later transition off that status
      // (a recovery, a correction, a restructure) would retroactively erase the
      // loan from a CLOSED quarter's historical figure. The timestamp is the
      // event; the status is current state.
      where: { tenantId, writeOffAt: { gte: start, lt: end }, ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.complianceRecord.count({
      where: section129SentInPeriodWhere(tenantId, start, end),
    }),
    prisma.loan.aggregate({
      where: { ...parWhere(tenantId, 1), ...NCA_ONLY },
      _count: true,
      _sum: { arrearsAmount: true, outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { ...parWhere(tenantId, 30), ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { ...parWhere(tenantId, 60), ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { ...parWhere(tenantId, 90), ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.aggregate({
      where: { tenantId, status: "DEFAULTED", ...NCA_ONLY },
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.count({
      where: { ...collectibleWhere(tenantId), collectionsStage: "ATTORNEY_REFERRED", ...NCA_ONLY },
    }),
    // findMany, not findFirst. More than one SUBMITTED row can exist for a
    // quarter — submission also resolves any lingering PENDING row, and that
    // flipped row carries NO snapshot. Ordering by completedAt alone let the
    // two tie (they are stamped from the same instant) and Postgres returned
    // them in arbitrary order, so the snapshot-less row could win and the page
    // would render the LIVE book for a quarter that was filed. The row that
    // carries readable filed figures is preferred explicitly below.
    prisma.complianceRecord.findMany({
      where: {
        tenantId,
        type: "NCR_QUARTERLY_RETURN",
        status: "SUBMITTED",
        data: { path: ["quarter"], equals: quarter },
      },
      orderBy: { completedAt: "desc" },
      take: 10,
    }),
  ])

  const bookValue = Number(book._sum.outstandingPrincipal ?? 0)
  const parValue = (agg: { _sum: { outstandingPrincipal: number | null } }) =>
    Number(agg._sum.outstandingPrincipal ?? 0)

  const lines: NcrReturnLine[] = [
    {
      key: "newAgreements",
      label: "New credit agreements entered",
      count: newAgreements._count,
      value: Number(newAgreements._sum.principal ?? 0),
      basis: "PERIOD",
      note: "Principal advanced, by agreement start date.",
    },
    {
      key: "receipts",
      label: "Receipts received",
      count: receipts._count,
      value: Number(receipts._sum.amount ?? 0),
      basis: "PERIOD",
      note: "All cash that reached us in the quarter, excluding reversals.",
    },
    {
      key: "applied",
      label: "— of which applied to accounts",
      count: applied._count,
      value: Number(applied._sum.amount ?? 0),
      basis: "PERIOD",
      note: "The remainder is unapplied or refundable over-payment.",
    },
    {
      key: "section129",
      label: "Section 129 notices issued",
      count: section129Issued,
      value: null,
      basis: "PERIOD",
      note: "Delivered notices only, from the statutory register.",
    },
    {
      key: "writeOffs",
      label: "Accounts written off",
      count: writeOffs._count,
      value: Number(writeOffs._sum.outstandingPrincipal ?? 0),
      basis: "PERIOD",
      note: "By write-off approval date; value is principal outstanding at write-off.",
    },
    {
      key: "book",
      label: "Collectible book (all still-owed accounts)",
      count: book._count,
      value: bookValue,
      basis: "POSITION",
      note: "Outstanding principal. The denominator for every percentage below.",
    },
    {
      key: "arrears",
      label: "Accounts in arrears (1+ days)",
      count: arrears._count,
      value: Number(arrears._sum.arrearsAmount ?? 0),
      basis: "POSITION",
      percentOfBook: pct(parValue(arrears), bookValue),
      note: "Value is the arrears balance; the percentage is exposure at risk.",
    },
    {
      key: "par30",
      label: "PAR30 — 30+ days past due",
      count: par30._count,
      value: parValue(par30),
      basis: "POSITION",
      percentOfBook: pct(parValue(par30), bookValue),
    },
    {
      key: "par60",
      label: "PAR60 — 60+ days past due",
      count: par60._count,
      value: parValue(par60),
      basis: "POSITION",
      percentOfBook: pct(parValue(par60), bookValue),
    },
    {
      key: "par90",
      label: "PAR90 / NPL — 90+ days past due",
      count: par90._count,
      value: parValue(par90),
      basis: "POSITION",
      percentOfBook: pct(parValue(par90), bookValue),
    },
    {
      key: "defaulted",
      label: "Accounts in default",
      count: defaulted._count,
      value: Number(defaulted._sum.outstandingPrincipal ?? 0),
      basis: "POSITION",
      note: "Outstanding principal, consistent with the book above.",
    },
    {
      key: "attorney",
      label: "Matters referred to attorney",
      count: attorneyReferrals,
      value: null,
      basis: "POSITION",
    },
  ]

  const submittedRecord = pickFiledRecord(submittedRecords)
  const filed = parseFiledSnapshot(submittedRecord?.data)

  const recordData = submittedRecord?.data
  const submittedByUserId =
    recordData && typeof recordData === "object" && !Array.isArray(recordData)
      && typeof (recordData as Record<string, unknown>).submittedByUserId === "string"
      ? String((recordData as Record<string, unknown>).submittedByUserId)
      : null
  let submittedByName: string | null = null
  if (submittedByUserId) {
    const user = await prisma.user.findUnique({
      where: { id: submittedByUserId },
      select: { name: true, email: true },
    })
    submittedByName = user ? user.name ?? user.email : null
  }

  return {
    quarter,
    periodStart: start,
    periodEnd: new Date(end.getTime() - 1),
    quarterOpen,
    // Throws LenderIdentityError when unset or invalid: a regulator return
    // must carry the tenant's own registration, never a default.
    ncrNumber: parseNcrNumber(tenantConfig?.ncrNumber),
    collectibleBook: { count: book._count, value: bookValue },
    lines,
    submittedAt: submittedRecord?.completedAt ?? null,
    submittedByName,
    filed,
    // Only meaningful with nothing filed: once `filed` is present the UI shows
    // the figures as filed, which are by definition right for the quarter.
    positionIsStale: !quarterOpen && filed === null,
    filedSnapshotUnreadable: submittedRecord !== null && filed === null,
  }
}

/**
 * Choose which SUBMITTED row represents the return. Prefer one whose snapshot
 * parses — a row without one cannot answer "what did we file" — and fall back
 * to the most recent so a legacy submission still reports as submitted.
 */
function pickFiledRecord<T extends { data: unknown }>(records: T[]): T | null {
  return records.find((r) => parseFiledSnapshot(r.data) !== null) ?? records[0] ?? null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * Read the figures as filed back out of `ComplianceRecord.data`. Defensive
 * throughout: the column is untyped JSON that may have been written by an older
 * deploy, and a malformed snapshot must degrade to "nothing filed" rather than
 * render a half-built return or throw on a compliance page.
 */
export function parseFiledSnapshot(data: unknown): NcrFiledSnapshot | null {
  if (!isRecord(data)) return null
  const snapshot = data.snapshot
  if (!isRecord(snapshot) || !Array.isArray(snapshot.lines)) return null

  const lines: NcrReturnLine[] = []
  for (const raw of snapshot.lines) {
    // Reject the WHOLE snapshot on any malformed line. Skipping the bad one
    // would render a return that is missing a statutory line while presenting
    // itself as the figures as filed — worse than falling back to the live
    // book with a caveat.
    if (!isRecord(raw)) return null
    if (typeof raw.key !== "string" || typeof raw.label !== "string") return null
    if (raw.basis !== "PERIOD" && raw.basis !== "POSITION") return null
    const percentOfBook = num(raw.percentOfBook)
    lines.push({
      key: raw.key,
      label: raw.label,
      count: num(raw.count),
      value: num(raw.value),
      basis: raw.basis,
      ...(percentOfBook === null ? {} : { percentOfBook }),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
    })
  }
  if (lines.length === 0) return null

  const bookRaw = isRecord(snapshot.collectibleBook) ? snapshot.collectibleBook : {}
  return {
    collectibleBook: {
      count: num(bookRaw.count) ?? 0,
      value: num(bookRaw.value) ?? 0,
    },
    lines,
  }
}

/**
 * What gets frozen into the ComplianceRecord at submission, so the record can
 * answer "what did we file, for which quarter" years later. Without this the
 * row is a bare SUBMITTED flag and the figures are unreconstructable — every
 * POSITION line would have moved by the time anyone asks.
 */
export function submissionSnapshot(data: NcrReturnData) {
  return {
    quarter: data.quarter,
    periodStart: data.periodStart.toISOString(),
    periodEnd: data.periodEnd.toISOString(),
    ncrNumber: data.ncrNumber,
    collectibleBook: data.collectibleBook,
    lines: data.lines.map((l) => ({
      key: l.key,
      label: l.label,
      count: l.count,
      value: l.value,
      basis: l.basis,
      ...(l.percentOfBook === undefined ? {} : { percentOfBook: l.percentOfBook }),
      // The note carries the basis caveat ("value is the arrears balance; the
      // percentage is exposure at risk"). Without it a filed snapshot renders a
      // value and a percentage that cannot be derived from each other, with no
      // explanation.
      ...(l.note === undefined ? {} : { note: l.note }),
    })),
  }
}

/**
 * Durable reservation key for a quarter's submission. Backed by
 * `ComplianceRecord.idempotencyKey`, which is `@unique`, so the database — not
 * a check-then-act read — is what makes a second submission for the same
 * quarter impossible. The constraint is global rather than per-tenant, hence
 * the tenant id in the key.
 */
export function ncrSubmissionKey(tenantId: string, quarter: string): string {
  return `ncr-return:${tenantId}:${quarter}`
}
