import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { CASH_THRESHOLD_CENTS } from "./cash-threshold"
import { cashAggregates, type CashAggregate } from "./cash-aggregation"
import type { CtrExportRow, StrExportRow } from "./goaml-export"

/**
 * Rows of DECIDED records shown at once (filed CTRs, closed STR cases). Work
 * still to do — unfiled CTR candidates, open STR cases — is never capped, and
 * exports are never capped: a register must not silently lose rows.
 */
export const RECORDED_PAGE_SIZE = 200
/** How far back the split-deposit flag looks. */
export const AGGREGATION_LOOKBACK_DAYS = 90

export type CtrCandidate = CtrExportRow & {
  clientId: string | null
  recordedAt: Date | null
  filedAt: Date | null
  note: string | null
}

const ctrSelect = {
  id: true, amount: true, receivedAt: true, reversed: true,
  loan: { select: { reference: true, client: { select: { id: true, reference: true, firstName: true, lastName: true, idNumber: true } } } },
  cashThresholdReport: { select: { status: true, fiuReference: true, filedAt: true, note: true, createdAt: true } },
} satisfies Prisma.PaymentSelect

type CtrPayment = Prisma.PaymentGetPayload<{ select: typeof ctrSelect }>

function toCandidate(p: CtrPayment): CtrCandidate {
  const c = p.loan.client
  return {
    paymentId: p.id,
    receivedAt: p.receivedAt,
    amountCents: p.amount,
    loanReference: p.loan.reference,
    clientId: c?.id ?? null,
    clientReference: c?.reference ?? "",
    clientName: c ? `${c.firstName} ${c.lastName}` : "",
    clientIdNumber: c?.idNumber ?? "",
    filingStatus: p.cashThresholdReport?.status ?? "UNFILED",
    fiuReference: p.cashThresholdReport?.fiuReference ?? null,
    receiptReversed: p.reversed,
    filedAt: p.cashThresholdReport?.filedAt ?? null,
    note: p.cashThresholdReport?.note ?? null,
    recordedAt: p.cashThresholdReport?.createdAt ?? null,
  }
}

/** Every reportable CASH receipt not yet dealt with, oldest first: never capped. */
const unfiledWhere = (tenantId: string): Prisma.PaymentWhereInput => ({
  tenantId, paymentMethod: "CASH", reversed: false, amount: { gte: CASH_THRESHOLD_CENTS }, cashThresholdReport: { is: null },
})
/** Every receipt with a recorded outcome, including one reversed after filing (shown as reversed). */
const recordedWhere = (tenantId: string): Prisma.PaymentWhereInput => ({ tenantId, cashThresholdReport: { isNot: null } })

export type CtrRegister = {
  unfiled: CtrCandidate[]
  recorded: CtrCandidate[]
  recordedTotal: number
  aggregates: Array<CashAggregate & { clientName: string }>
}

/** The cash threshold register as the page shows it. Derived on read: every capture path is covered. */
export async function loadCtrRegister(tenantId: string, now: Date = new Date()): Promise<CtrRegister> {
  const since = new Date(now.getTime() - AGGREGATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const [unfiled, recorded, recordedTotal, smallCash] = await Promise.all([
    prisma.payment.findMany({ where: unfiledWhere(tenantId), orderBy: { receivedAt: "asc" }, select: ctrSelect }),
    prisma.payment.findMany({ where: recordedWhere(tenantId), orderBy: { receivedAt: "desc" }, take: RECORDED_PAGE_SIZE, select: ctrSelect }),
    prisma.payment.count({ where: recordedWhere(tenantId) }),
    prisma.payment.findMany({
      where: { tenantId, paymentMethod: "CASH", reversed: false, amount: { lt: CASH_THRESHOLD_CENTS }, receivedAt: { gte: since } },
      select: { id: true, amount: true, receivedAt: true, reversed: true, paymentMethod: true, loan: { select: { client: { select: { id: true, firstName: true, lastName: true } } } } },
    }),
  ])
  const names = new Map(smallCash.flatMap((p) => (p.loan.client ? [[p.loan.client.id, `${p.loan.client.firstName} ${p.loan.client.lastName}`] as const] : [])))
  const aggregates = cashAggregates(smallCash.map((p) => ({
    paymentId: p.id, clientId: p.loan.client?.id ?? null, amount: p.amount, receivedAt: p.receivedAt, reversed: p.reversed, paymentMethod: p.paymentMethod,
  }))).map((g) => ({ ...g, clientName: names.get(g.clientId) ?? "" }))
  return { unfiled: unfiled.map(toCandidate), recorded: recorded.map(toCandidate), recordedTotal, aggregates }
}

/** Every CTR row for the goAML-ready export: unfiled and recorded, uncapped. */
export async function loadAllCtrForExport(tenantId: string): Promise<CtrCandidate[]> {
  const [unfiled, recorded] = await Promise.all([
    prisma.payment.findMany({ where: unfiledWhere(tenantId), orderBy: { receivedAt: "asc" }, select: ctrSelect }),
    prisma.payment.findMany({ where: recordedWhere(tenantId), orderBy: { receivedAt: "asc" }, select: ctrSelect }),
  ])
  return [...unfiled, ...recorded].map(toCandidate)
}

export type StrCaseRow = StrExportRow & {
  id: string
  clientId: string | null
  loanId: string | null
  paymentId: string | null
  raisedById: string
  assessedAt: Date | null
  closedAt: Date | null
}

const strInclude = {
  client: { select: { reference: true, firstName: true, lastName: true, idNumber: true } },
  loan: { select: { reference: true } },
  payment: { select: { amount: true, receivedAt: true } },
} satisfies Prisma.SuspiciousReportCaseInclude

function toStrRow(c: Prisma.SuspiciousReportCaseGetPayload<{ include: typeof strInclude }>): StrCaseRow {
  return {
    id: c.id, reference: c.reference, kind: c.kind, status: c.status, raisedAt: c.raisedAt, raisedById: c.raisedById,
    clientId: c.clientId, loanId: c.loanId, paymentId: c.paymentId,
    clientReference: c.client?.reference ?? null,
    clientName: c.client ? `${c.client.firstName} ${c.client.lastName}` : null,
    clientIdNumber: c.client?.idNumber ?? null,
    loanReference: c.loan?.reference ?? null,
    paymentAmountCents: c.payment?.amount ?? null,
    paymentDate: c.payment?.receivedAt ?? null,
    grounds: c.grounds, assessmentNote: c.assessmentNote, fiuReference: c.fiuReference,
    reportedAt: c.reportedAt, assessedAt: c.assessedAt, closedAt: c.closedAt,
  }
}

export type StrRegister = { open: StrCaseRow[]; decided: StrCaseRow[]; decidedTotal: number }

/** Open cases all (oldest first); decided cases newest first, a page at a time, with the true total. */
export async function loadStrRegister(tenantId: string): Promise<StrRegister> {
  const decidedWhere = { tenantId, status: { in: ["REPORTED", "CLOSED_NO_REPORT"] } } satisfies Prisma.SuspiciousReportCaseWhereInput
  const [open, decided, decidedTotal] = await Promise.all([
    prisma.suspiciousReportCase.findMany({ where: { tenantId, status: { in: ["OPEN", "UNDER_REVIEW"] } }, orderBy: { raisedAt: "asc" }, include: strInclude }),
    prisma.suspiciousReportCase.findMany({ where: decidedWhere, orderBy: { raisedAt: "desc" }, take: RECORDED_PAGE_SIZE, include: strInclude }),
    prisma.suspiciousReportCase.count({ where: decidedWhere }),
  ])
  return { open: open.map(toStrRow), decided: decided.map(toStrRow), decidedTotal }
}

/** One case, or every case for the export (uncapped, oldest first). */
export async function listStrCases(tenantId: string, where: { id?: string } = {}): Promise<StrCaseRow[]> {
  const cases = await prisma.suspiciousReportCase.findMany({ where: { tenantId, ...where }, orderBy: { raisedAt: "asc" }, include: strInclude })
  return cases.map(toStrRow)
}
