import type { Prisma } from "@prisma/client"

/**
 * Acquire a PostgreSQL row-level write lock (`SELECT … FOR UPDATE`) on a loan,
 * serialising every concurrent writer that touches the same loan's balances
 * (manual capture, bulk upload, portal webhook, reversal, bank-sync apply).
 *
 * MUST be the FIRST statement inside the transaction, before the loan +
 * schedule are read. The payment paths do a read-modify-write on
 * `Loan.totalPaid` / `RepaymentSchedule.totalPaid` with absolute values; under
 * Postgres' default Read-Committed isolation two concurrent receipts both read
 * the pre-payment balance and the second write clobbers the first — one payment
 * silently vanishes from the balance while both `Payment` rows persist (lost
 * update). The lock makes the second transaction block until the first commits,
 * so it reads the already-updated balance.
 *
 * Locking is by primary key; tenant ownership is validated by the subsequent
 * tenant-scoped read (a wrong-tenant id locks nothing and then 404s). Raw query
 * so it bypasses the tenant-scope Prisma extension (which would otherwise reject
 * a raw lock it can't rewrite).
 */
// Structural type (just $queryRaw) so both a plain PrismaClient transaction and
// the tenant-scope-extended client's transaction satisfy it.
export type LoanLockTx = Pick<Prisma.TransactionClient, "$queryRaw">

export async function lockLoanForUpdate(tx: LoanLockTx, loanId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Loan" WHERE id = ${loanId} FOR UPDATE`
}

/**
 * Serialise balance/state writers while still allowing a concurrent transaction
 * to take the KEY SHARE lock PostgreSQL needs when it creates a row with a
 * foreign key to this Loan. Section 129 dispatch holds this lock across the
 * provider boundary; using FOR UPDATE there deadlocks the messaging pipeline
 * when it first creates a loan-linked Conversation in its own transaction.
 *
 * FOR NO KEY UPDATE conflicts with both FOR UPDATE and FOR NO KEY UPDATE, so
 * payment and collections writers remain serialised. It deliberately does not
 * conflict with FOR KEY SHARE because this dispatch path never changes Loan.id.
 */
export async function lockLoanForNoKeyUpdate(tx: LoanLockTx, loanId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Loan" WHERE id = ${loanId} FOR NO KEY UPDATE`
}
