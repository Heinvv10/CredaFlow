import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { notHeldLoanWhere } from "@/lib/collections/dunning-holds"

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

interface ClientHoldRow {
  deceasedAt: Date | null
  loans: { reference: string; debtReviewNoticeAt: Date | null; debtReviewNoticeRef: string | null }[]
}

async function loadClientHold(db: ClientHoldDb, tenantId: string, clientId: string): Promise<ClientHoldRow | null> {
  return await db.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      deceasedAt: true,
      loans: {
        where: { debtReviewNoticeAt: { not: null } },
        orderBy: { debtReviewNoticeAt: "asc" },
        take: 1,
        select: { reference: true, debtReviewNoticeAt: true, debtReviewNoticeRef: true },
      },
    },
  }) as ClientHoldRow | null
}

function debtReviewText(row: ClientHoldRow): string | null {
  const notice = row.loans[0]
  if (!notice?.debtReviewNoticeAt) return null
  const ref = notice.debtReviewNoticeRef ? `, reference ${notice.debtReviewNoticeRef}` : ""
  return `under debt review (NCA s.86 notice received ${formatDate(notice.debtReviewNoticeAt)}${ref}, recorded on loan ${notice.reference})`
}

/** Why a Section 129 notice must not go to this client, or null when debt review does not block it. */
export async function section129DebtReviewReason(
  db: ClientHoldDb,
  args: { tenantId: string; clientId: string },
): Promise<string | null> {
  const row = await loadClientHold(db, args.tenantId, args.clientId)
  const text = row && debtReviewText(row)
  return text ? `the client is ${text}. A Section 129 notice cannot be issued until the notice is cleared` : null
}

/** Why a staff member may not message this client, or null when nothing blocks it. */
export async function staffMessageRefusal(
  db: ClientHoldDb,
  args: { tenantId: string; clientId: string },
): Promise<string | null> {
  const row = await loadClientHold(db, args.tenantId, args.clientId)
  if (!row) return null
  if (row.deceasedAt) return "a death is recorded for this client"
  const text = debtReviewText(row)
  return text ? `the client is ${text}` : null
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
