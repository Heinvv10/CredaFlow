import type { LoanStatus, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { nextInstalmentOwed, nothingOwed, type InstalmentDb } from "@/lib/collections/amount-owed"
import { notHeldLoanWhere, remindableLoanWhere } from "@/lib/collections/dunning-holds"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"

/**
 * The holds that are decided per client or loan at the moment of a staff action
 * or a statutory step, as opposed to the where-fragments that select loans for
 * the crons (dunning-holds.ts).
 *
 *  - Section 129 is BLOCKED while a debt-review notice (NCA s.86) is recorded on
 *    ANY loan of the client (Hein, D1). The single and bulk routes, the
 *    automation ISSUE_SECTION_129 task and the dispatch-time recheck all use
 *    `section129DebtReviewReason`.
 *  - A staff-initiated message (manual reminder, collections-stage WhatsApp) is
 *    REFUSED when the client is deceased or under debt review (D2).
 *    Arrangement and attorney-referred loans stay allowed: a person chose to
 *    write to them.
 */

// Structural, so a transaction client of the tenant-scoped extension fits too.
export interface ClientHoldDb {
  client: { findFirst: (args: Prisma.ClientFindFirstArgs) => PromiseLike<unknown> }
}

/** What holds a client, read once: a recorded death, and the earliest debt-review notice on any of their loans. */
export interface ClientHold {
  deceased: boolean
  debtReview: { loanId: string; loanReference: string; noticeAt: Date; noticeRef: string | null } | null
}

interface ClientHoldRow {
  deceasedAt: Date | null
  loans: { id: string; reference: string; debtReviewNoticeAt: Date | null; debtReviewNoticeRef: string | null }[]
}

/** One query per call: a caller that needs several answers loads once and uses the `...From` functions. */
export async function loadClientHold(db: ClientHoldDb, tenantId: string, clientId: string): Promise<ClientHold | null> {
  const row = await db.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      deceasedAt: true,
      loans: {
        where: { debtReviewNoticeAt: { not: null } },
        orderBy: { debtReviewNoticeAt: "asc" },
        take: 1,
        select: { id: true, reference: true, debtReviewNoticeAt: true, debtReviewNoticeRef: true },
      },
    },
  }) as ClientHoldRow | null
  if (!row) return null
  const notice = row.loans[0]
  return {
    deceased: row.deceasedAt !== null,
    debtReview: notice?.debtReviewNoticeAt
      ? { loanId: notice.id, loanReference: notice.reference, noticeAt: notice.debtReviewNoticeAt, noticeRef: notice.debtReviewNoticeRef }
      : null,
  }
}

function debtReviewText(hold: ClientHold): string | null {
  const notice = hold.debtReview
  if (!notice) return null
  const ref = notice.noticeRef ? `, reference ${notice.noticeRef}` : ""
  return `under debt review (NCA s.86 notice received ${formatDate(notice.noticeAt)}${ref}, recorded on loan ${notice.loanReference})`
}

/** Why a Section 129 notice must not go to this client, or null when debt review does not block it. */
export function section129ReasonFrom(hold: ClientHold | null): string | null {
  const text = hold && debtReviewText(hold)
  return text ? `the client is ${text}. A Section 129 notice cannot be issued until the notice is cleared` : null
}

/** Why a staff member may not message this client, or null when nothing blocks it. */
export function staffRefusalFrom(hold: ClientHold | null): string | null {
  if (!hold) return null
  if (hold.deceased) return "a death is recorded for this client"
  const text = debtReviewText(hold)
  return text ? `the client is ${text}` : null
}

/** The client's notice when it sits on a loan other than `loanId` (for the loan page's debt-review panel). */
export function siblingNoticeFrom(hold: ClientHold | null, loanId: string): { loanId: string; loanReference: string; noticeAt: Date } | null {
  const notice = hold?.debtReview
  return notice && notice.loanId !== loanId ? { loanId: notice.loanId, loanReference: notice.loanReference, noticeAt: notice.noticeAt } : null
}

export async function section129DebtReviewReason(
  db: ClientHoldDb,
  args: { tenantId: string; clientId: string },
): Promise<string | null> {
  return section129ReasonFrom(await loadClientHold(db, args.tenantId, args.clientId))
}

export async function staffMessageRefusal(
  db: ClientHoldDb,
  args: { tenantId: string; clientId: string },
): Promise<string | null> {
  return staffRefusalFrom(await loadClientHold(db, args.tenantId, args.clientId))
}

/**
 * Why a queued DUNNING message for this Contact must not be re-sent (the
 * messaging retry sweep, lib/messaging/retry.ts), and which hold it is: the
 * Contact's client is deceased, or under debt review. A Contact with no client
 * (a lead) has no hold. Only dunning is held: the caller asks for messages
 * flagged `Message.dunning` (lib/messaging/dunning-category.ts).
 *
 * The hold keys on the Contact's OWN client, whatever entity roles that person
 * has, and fails closed: a director under personal debt review is held on a
 * retry of their own consumer reminder. The accepted trade-off is that an
 * entity-debt reminder sent to such a director may be held on retry too (its
 * first send went out), because a Message carries no loan column. The loan an
 * AUTOMATED dunning message is about is read from its idempotency key instead
 * (`automatedDunningLoan`) and held by `loanDunningHold`.
 */
export async function contactDunningHold(
  db: ClientHoldDb & { contact: { findFirst: (args: Prisma.ContactFindFirstArgs) => PromiseLike<unknown> } },
  args: { tenantId: string; contactId: string },
): Promise<{ kind: "DECEASED" | "DEBT_REVIEW"; reason: string } | null> {
  const contact = await db.contact.findFirst({ where: { id: args.contactId, tenantId: args.tenantId }, select: { clientId: true } }) as { clientId: string | null } | null
  if (!contact?.clientId) return null
  const hold = await loadClientHold(db, args.tenantId, contact.clientId)
  if (!hold) return null
  const reason = staffRefusalFrom(hold)
  if (!reason) return null
  return { kind: hold.deceased ? "DECEASED" : "DEBT_REVIEW", reason }
}

// Structural, so a transaction client of the tenant-scoped extension fits too.
export interface LoanHoldDb {
  loan: {
    findFirst: (args: Prisma.LoanFindFirstArgs) => PromiseLike<unknown>
    count: (args: Prisma.LoanCountArgs) => PromiseLike<number>
  }
}

/**
 * Why a queued automated dunning message about this loan must not be re-sent, or
 * null: the loan is no longer in a status that is dunned (`statuses`), or it is on
 * a hold (an arrangement, a payment plan, an attorney referral, a write-off, a
 * death, a debt review), or (for a REMINDER, `reminder`) the borrower has since paid
 * and nothing is owed (`nothingOwed`, the definition the reminders cron skips by).
 * A loan that cannot be found is no reason: the key's subject was not a loan. Run in
 * the retry sweep's eligibility transaction.
 */
export async function loanDunningHold(
  db: LoanHoldDb & Partial<InstalmentDb>,
  args: { tenantId: string; loanId: string; statuses: readonly LoanStatus[]; reminder?: { overdue: boolean; asOf: Date } },
): Promise<string | null> {
  const loan = await db.loan.findFirst({ where: { id: args.loanId, tenantId: args.tenantId }, select: { status: true, arrearsAmount: true } }) as { status: LoanStatus; arrearsAmount: number } | null
  if (!loan) return null
  if (!args.statuses.includes(loan.status)) return `the loan is ${loan.status}`
  const notHeld = await db.loan.count({ where: { id: args.loanId, tenantId: args.tenantId, ...notHeldLoanWhere() } })
  if (notHeld === 0) return "the loan is under an arrangement, a payment plan, an attorney referral, a write-off or a debt review"
  if (args.reminder) {
    const ref = { tenantId: args.tenantId, loanId: args.loanId }
    const paymentAmount = await nextInstalmentOwed(db as InstalmentDb, ref)
    const charges = await chargesOutstandingAt(db as unknown as Parameters<typeof chargesOutstandingAt>[0], ref, args.reminder.asOf)
    if (nothingOwed({ paymentAmount, charges, arrearsAmount: loan.arrearsAmount, overdue: args.reminder.overdue })) return "nothing is owed on the loan now, it was paid since this reminder was queued"
  }
  return null
}

/** True when the reminders cron may still remind this loan: ACTIVE and not held (remindableLoanWhere), read again just before each send. */
export async function isLoanRemindable(args: { tenantId: string; loanId: string }): Promise<boolean> {
  return (await prisma.loan.count({ where: { id: args.loanId, tenantId: args.tenantId, ...remindableLoanWhere() } })) > 0
}

/** True when automated dunning must not reach this loan (the escalation cron's borrower notification). */
export async function isLoanHeld(args: { tenantId: string; loanId: string }): Promise<boolean> {
  const notHeld = await prisma.loan.count({
    where: { id: args.loanId, tenantId: args.tenantId, ...notHeldLoanWhere() },
  })
  return notHeld === 0
}

/** Of these clients, the ones with a debt-review notice on any of their loans (the bulk Section 129 batch). */
export async function clientIdsUnderDebtReview(args: { tenantId: string; clientIds: string[] }): Promise<Set<string>> {
  if (args.clientIds.length === 0) return new Set()
  const rows = await prisma.loan.findMany({
    where: { tenantId: args.tenantId, clientId: { in: args.clientIds }, debtReviewNoticeAt: { not: null } },
    select: { clientId: true },
  })
  return new Set(rows.flatMap((row) => (row.clientId ? [row.clientId] : [])))
}
