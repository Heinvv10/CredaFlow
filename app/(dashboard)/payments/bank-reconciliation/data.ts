import { prisma } from "@/lib/prisma"

export type ReconciliationLoanRef = {
  id: string
  reference: string
  client: { firstName: string; lastName: string } | null
  entity: { legalName: string } | null
}

export type ReconciliationTxn = {
  id: string
  postedDate: string
  amountCents: number
  rawReference: string | null
  counterparty: string | null
  matchStatus: string
  matchConfidence: string | null
  matchedLoanId: string | null
  matchedLoan: ReconciliationLoanRef | null
}

export async function getReconciliationData(tenantId: string): Promise<{
  txns: ReconciliationTxn[]
  candidateLoans: ReconciliationLoanRef[]
}> {
  const txns = await prisma.bankTransaction.findMany({
    // Only CREDIT deposits are reconcilable against a loan; DEBIT lines (bank
    // fees, reversals out) still land as UNMATCHED but are excluded here so they
    // don't clutter the review queue. They remain stored on BankTransaction.
    where: {
      tenantId,
      direction: "CREDIT",
      matchStatus: { in: ["PROPOSED", "UNMATCHED"] },
    },
    orderBy: { postedDate: "desc" },
    take: 200,
  })

  // BankTransaction.matchedLoanId is a bare string id (no Prisma relation —
  // see prisma/schema/loans-payments.prisma), so the matched loan's reference/client name
  // has to be resolved with a second query rather than `include`.
  const matchedLoanIds = [...new Set(txns.map((t) => t.matchedLoanId).filter((id): id is string => !!id))]
  const matchedLoans = matchedLoanIds.length
    ? await prisma.loan.findMany({
        where: { id: { in: matchedLoanIds }, tenantId },
        select: { id: true, reference: true, client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } },
      })
    : []
  const matchedLoanById = new Map(matchedLoans.map((l) => [l.id, l]))

  // Candidate loans for the UNMATCHED "assign to loan" input — same universe
  // the auto-matcher considers (lib/bank-sync/candidates.ts), so an operator
  // can only assign to a loan the system would have been able to match too.
  //
  // Deliberately NOT COLLECTIBLE_STATUSES: this is payment-allocation
  // eligibility, not a reporting population. It must track
  // lib/bank-sync/candidates.ts, or an operator is offered a loan the applier
  // will refuse.
  const candidateLoans = await prisma.loan.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    select: { id: true, reference: true, client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } } },
    orderBy: { reference: "asc" },
    take: 500,
  })

  return {
    txns: txns.map((t) => ({
      id: t.id,
      postedDate: t.postedDate.toISOString(),
      amountCents: t.amountCents,
      rawReference: t.rawReference,
      counterparty: t.counterparty,
      matchStatus: t.matchStatus,
      matchConfidence: t.matchConfidence,
      matchedLoanId: t.matchedLoanId,
      matchedLoan: t.matchedLoanId ? matchedLoanById.get(t.matchedLoanId) ?? null : null,
    })),
    candidateLoans,
  }
}
