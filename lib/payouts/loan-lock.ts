/**
 * The one lock order for every write that decides whether money may move on a
 * loan (a retry request or approval, a reversal request or approval): the
 * Loan row first, FOR UPDATE, then the payout and reversal rows. Two such
 * writes on one loan therefore run one after the other, and each re-reads the
 * other's committed result before it acts — so a retry and a reversal cannot
 * both win (the payout and reversal guards refuse the loser too).
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export const PAYABLE_LOAN_STATUSES = ["ACTIVE", "DEFAULTED"] as const

export async function lockLoanForPayout(tx: Tx, tenantId: string, loanId: string): Promise<{ status: string } | null> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT "status"::TEXT AS "status" FROM "Loan" WHERE "id" = ${loanId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  return rows[0] ?? null
}

/** Whether a loan is open to a payout decision right now (read under the lock). */
export async function payoutBlocker(tx: Tx, tenantId: string, loanId: string): Promise<string | null> {
  const loan = await lockLoanForPayout(tx, tenantId, loanId)
  if (!loan) return "Loan not found"
  if (!(PAYABLE_LOAN_STATUSES as readonly string[]).includes(loan.status)) return "The loan is no longer active; no payout can be made on it"
  const reversal = await tx.disbursementReversal.findFirst({ where: { tenantId, loanId, status: { not: "REJECTED" } }, select: { id: true } })
  if (reversal) return "A reversal of this disbursement is open; decide it first"
  const conflict = await tx.disbursementPayout.findFirst({ where: { tenantId, loanId, providerConflictAt: { not: null }, conflictResolvedAt: null }, select: { id: true } })
  if (conflict) return "A provider reported money moving on an attempt already over; resolve that first"
  return null
}

/**
 * A refusal by a database guard or a unique index, as the 409 a person can
 * act on; anything else is rethrown. The losers of a race arrive here.
 */
export function raceRefusal(error: unknown): { ok: false; status: 409; error: string } | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return { ok: false, status: 409, error: "Another request for this payout won; refresh and try again" }
  }
  const message = error instanceof Error ? error.message : ""
  const guard = /(Payout guard|Reversal guard|Loan cancellation guard): ([^\n"]+)/.exec(message)
  if (guard) return { ok: false, status: 409, error: guard[2].trim() }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return { ok: false, status: 409, error: "Another request for this loan won; refresh and try again" }
  }
  return null
}
