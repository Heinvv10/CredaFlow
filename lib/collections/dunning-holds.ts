import type { CollectionsStage, Prisma } from "@prisma/client"

/**
 * The one rule for "may an automated reminder go to this loan's borrower".
 *
 * Every reminder cron selects its loans through `remindableLoanWhere()`
 * (lib/collections/reminders.ts and app/api/cron/payment-reminders), so a hold
 * added here reaches all of them and the crons cannot drift apart. A loan is
 * remindable only if ALL of these hold:
 *
 *  - status is ACTIVE (not DEFAULTED, PENDING_WRITE_OFF, WRITTEN_OFF,
 *    COMPLETED, CANCELLED, RESTRUCTURED);
 *  - collectionsStage is not PAYMENT_ARRANGEMENT, ATTORNEY_REFERRED or
 *    WRITTEN_OFF: a person or a legal process owns the account;
 *  - no PaymentArrangement with status ACTIVE: the borrower is on a plan, and a
 *    KEPT/BROKEN/COMPLETED one is over;
 *  - the borrower is not deceased (an entity borrower has no client, so it is
 *    never held by this clause);
 *  - no debt-review notice is recorded (NCA s.86): the debt counsellor, not the
 *    lender, is dealing with the consumer.
 *
 * Complaints deliberately do NOT hold dunning (Hein, 2026-10-19).
 *
 * This is a where-fragment, not a post-filter: the crons must not even load a
 * held loan, and the integration test runs it against real Postgres
 * (dunning-holds.integration.test.ts), which a mocked Prisma cannot do.
 */
export const HELD_COLLECTIONS_STAGES: readonly CollectionsStage[] = [
  "PAYMENT_ARRANGEMENT",
  "ATTORNEY_REFERRED",
  "WRITTEN_OFF",
]

export function remindableLoanWhere(): Prisma.LoanWhereInput {
  return {
    status: "ACTIVE",
    collectionsStage: { notIn: [...HELD_COLLECTIONS_STAGES] },
    debtReviewNoticeAt: null,
    // AND of single-key clauses: spreading this into a caller's where cannot
    // collide with a NOT/OR the caller already has.
    AND: [
      { NOT: { paymentArrangement: { is: { status: "ACTIVE" } } } },
      { OR: [{ clientId: null }, { client: { deceasedAt: null } }] },
    ],
  }
}
