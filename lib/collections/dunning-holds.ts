import type { CollectionsStage, Prisma } from "@prisma/client"

/**
 * The one rule for "may an AUTOMATED reminder go to this loan's borrower".
 *
 * Every automated dunning path takes its loans from here: the two reminder
 * crons (lib/collections/reminders.ts, app/api/cron/payment-reminders) through
 * `remindableLoanWhere()`, and the escalation cron's borrower notification
 * through `notHeldLoanWhere()` (lib/collections/client-holds.ts). A loan is held
 * if ANY of these is true:
 *
 *  - collectionsStage is ATTORNEY_REFERRED or WRITTEN_OFF: a legal process or a
 *    write-off owns the account. PAYMENT_ARRANGEMENT is NOT a hold on its own:
 *    the stage never moves back, so an arrangement that ended (BROKEN, KEPT,
 *    COMPLETED) would otherwise silence the loan forever. The ACTIVE
 *    arrangement below decides;
 *  - an ACTIVE PaymentArrangement, or an active PaymentPlan: the borrower is on
 *    a plan;
 *  - the borrower is deceased (an entity borrower has no client, so it is never
 *    held by the client clauses);
 *  - a debt-review notice (NCA s.86) is recorded on THIS loan or on ANY loan of
 *    the same client: debt review is consumer-wide, the counsellor is dealing
 *    with all of the consumer's debts with this lender.
 *
 * `remindableLoanWhere()` adds status ACTIVE: DEFAULTED, PENDING_WRITE_OFF,
 * WRITTEN_OFF, COMPLETED, CANCELLED and RESTRUCTURED loans are not reminded.
 *
 * Complaints deliberately do NOT hold dunning (Hein, 2026-10-19). Staff-initiated
 * messages and Section 129 are held by their own rules (client-holds.ts).
 *
 * These are where-fragments, not post-filters: the crons must not even load a
 * held loan, and the integration test runs them against real Postgres
 * (dunning-holds.integration.test.ts), which a mocked Prisma cannot do.
 */
export const HELD_COLLECTIONS_STAGES: readonly CollectionsStage[] = [
  "ATTORNEY_REFERRED",
  "WRITTEN_OFF",
]

/** Not held, whatever the loan's status. */
export function notHeldLoanWhere(): Prisma.LoanWhereInput {
  return {
    collectionsStage: { notIn: [...HELD_COLLECTIONS_STAGES] },
    debtReviewNoticeAt: null,
    // AND of single-key clauses: spreading this into a caller's where cannot
    // collide with a NOT/OR the caller already has.
    AND: [
      { NOT: { paymentArrangement: { is: { status: "ACTIVE" } } } },
      { NOT: { paymentPlan: { is: { active: true } } } },
      {
        OR: [
          { clientId: null },
          { client: { deceasedAt: null, loans: { none: { debtReviewNoticeAt: { not: null } } } } },
        ],
      },
    ],
  }
}

/** ACTIVE and not held: the loans an automated reminder may reach. */
export function remindableLoanWhere(): Prisma.LoanWhereInput {
  return { status: "ACTIVE", ...notHeldLoanWhere() }
}
