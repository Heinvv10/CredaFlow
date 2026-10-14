import { prisma } from "@/lib/prisma"
import { CASH_THRESHOLD_CENTS, isReportableCash } from "./cash-threshold"
import type { CtrExportRow, StrExportRow } from "./goaml-export"

/** Rows shown and exported at once. */
export const REGISTER_ROW_CAP = 500

export type CtrCandidate = CtrExportRow & {
  clientId: string | null
  recordedAt: Date | null
  filedAt: Date | null
  note: string | null
}

/**
 * The cash threshold register: every CASH receipt at or above the threshold
 * (lib/fic/cash-threshold.ts), newest first, with what the compliance officer
 * recorded about it. Derived on read, so a receipt captured by any path —
 * capture form, bulk upload, bank sync — appears without a hook in each.
 */
export async function listCtrCandidates(tenantId: string): Promise<CtrCandidate[]> {
  const payments = await prisma.payment.findMany({
    where: { tenantId, paymentMethod: "CASH", reversed: false, amount: { gte: CASH_THRESHOLD_CENTS } },
    orderBy: { receivedAt: "desc" },
    take: REGISTER_ROW_CAP,
    select: {
      id: true, amount: true, receivedAt: true, paymentMethod: true, reversed: true,
      loan: {
        select: {
          reference: true,
          client: { select: { id: true, reference: true, firstName: true, lastName: true, idNumber: true } },
        },
      },
      cashThresholdReport: { select: { status: true, fiuReference: true, filedAt: true, note: true, createdAt: true } },
    },
  })
  return payments.filter(isReportableCash).map((p) => ({
    paymentId: p.id,
    receivedAt: p.receivedAt,
    amountCents: p.amount,
    loanReference: p.loan.reference,
    clientId: p.loan.client?.id ?? null,
    clientReference: p.loan.client?.reference ?? "",
    clientName: p.loan.client ? `${p.loan.client.firstName} ${p.loan.client.lastName}` : "",
    clientIdNumber: p.loan.client?.idNumber ?? "",
    filingStatus: p.cashThresholdReport?.status ?? "UNFILED",
    fiuReference: p.cashThresholdReport?.fiuReference ?? null,
    filedAt: p.cashThresholdReport?.filedAt ?? null,
    note: p.cashThresholdReport?.note ?? null,
    recordedAt: p.cashThresholdReport?.createdAt ?? null,
  }))
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

export async function listStrCases(tenantId: string, where: { id?: string } = {}): Promise<StrCaseRow[]> {
  const cases = await prisma.suspiciousReportCase.findMany({
    where: { tenantId, ...where },
    orderBy: { raisedAt: "desc" },
    take: REGISTER_ROW_CAP,
    include: {
      client: { select: { reference: true, firstName: true, lastName: true, idNumber: true } },
      loan: { select: { reference: true } },
      payment: { select: { amount: true, receivedAt: true } },
    },
  })
  return cases.map((c) => ({
    id: c.id,
    reference: c.reference,
    kind: c.kind,
    status: c.status,
    raisedAt: c.raisedAt,
    raisedById: c.raisedById,
    clientId: c.clientId,
    loanId: c.loanId,
    paymentId: c.paymentId,
    clientReference: c.client?.reference ?? null,
    clientName: c.client ? `${c.client.firstName} ${c.client.lastName}` : null,
    clientIdNumber: c.client?.idNumber ?? null,
    loanReference: c.loan?.reference ?? null,
    paymentAmountCents: c.payment?.amount ?? null,
    paymentDate: c.payment?.receivedAt ?? null,
    grounds: c.grounds,
    assessmentNote: c.assessmentNote,
    fiuReference: c.fiuReference,
    reportedAt: c.reportedAt,
    assessedAt: c.assessedAt,
    closedAt: c.closedAt,
  }))
}
