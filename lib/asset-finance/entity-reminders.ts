/**
 * Payment reminders for an entity-borrower loan, called by the reminder
 * cron where it skips a loan with no `Client`:
 *  - lib/collections/reminders.ts (the dunning triggers: 7, 1 and 0 days
 *    before due, 1 and 3 days after): the trigger's WhatsApp leg. Its SMS leg
 *    is never sent for an entity (SMS is off by policy, and an entity notice
 *    has no SMS copy). The overdue triggers' `loan_overdue` email goes through
 *    triggerNotification, which routes an entity loan to ./entity-notifications.ts.
 * Recipients, wording and dispatch: ./entity-contacts.ts, ./entity-notices.ts,
 * ./entity-dispatch.ts. Always the sendMessage() pipeline, whatever the
 * crons' legacy/new-send flags say: there is no legacy entity path to keep.
 *
 * The caller keeps its own marker rule (LoanNote of the trigger's type); this
 * reports what happened so the caller can apply it.
 */
import { prisma } from "@/lib/prisma"
import { entityContactRecipients, type EntityContact } from "./entity-contacts"
import {
  describeEntityOutcomes,
  reachedProvider,
  sendEntityNotice,
  type EntityChannel,
  type EntityLegOutcome,
} from "./entity-dispatch"
import type { EntityNoticeFacts, EntityNoticeLender } from "./entity-notices"

export interface EntityReminderLoan {
  id: string
  reference: string
  entityId: string
  entityName: string
}

export interface EntityReminderResult {
  recipients: EntityContact[]
  outcomes: EntityLegOutcome[]
  /** some leg was sent (or simulated) */
  delivered: boolean
  /** some leg reached (or may have reached) a provider: delivered or held for reconciliation */
  reached: boolean
  /** some leg's outcome is uncertain (queued, or held for reconciliation) */
  uncertain: boolean
  /** some leg failed for a reason a later run could fix */
  failed: boolean
  /** "recipient N <channel>: <status> (<reason>)" per leg: names no one, for the cron's report */
  summary: string
  /** The same with each recipient's name: for the LoanNote, a staff record */
  namedSummary: string
}

export async function sendEntityReminder(args: {
  tenantId: string
  loan: EntityReminderLoan
  kind: Extract<EntityNoticeFacts["kind"], "due" | "overdue">
  amountCents: number
  dueDate: Date
  daysOverdue?: number
  lender: EntityNoticeLender
  channels: EntityChannel[]
  /** the reminder occurrence, unique per loan: e.g. `reminder_1d:2026-11-01` */
  occurrence: string
  category: string
}): Promise<EntityReminderResult> {
  const recipients = await entityContactRecipients(prisma, args.tenantId, args.loan.entityId)
  const outcomes = await sendEntityNotice({
    tenantId: args.tenantId,
    loanId: args.loan.id,
    facts: {
      kind: args.kind,
      entityName: args.loan.entityName,
      reference: args.loan.reference,
      amountCents: args.amountCents,
      dueDate: args.dueDate,
      daysOverdue: args.daysOverdue,
    },
    lender: args.lender,
    recipients,
    channels: args.channels,
    occurrence: args.occurrence,
    category: args.category,
  })
  const names = new Map(recipients.map((r) => [r.clientId, `${r.firstName} ${r.lastName}`.trim()]))
  return {
    recipients,
    outcomes,
    delivered: outcomes.some((o) => o.status === "sent" || o.status === "simulated"),
    reached: outcomes.some(reachedProvider),
    uncertain: outcomes.some((o) => o.status === "pending" || o.status === "reconciliation"),
    failed: outcomes.some((o) => o.status === "failed"),
    summary: describeEntityOutcomes(outcomes),
    namedSummary: describeEntityOutcomes(outcomes, names),
  }
}

/** The LoanNote a reminder cron writes as its marker, naming each leg. */
export async function recordEntityReminder(
  tenantId: string,
  loan: EntityReminderLoan,
  type: string,
  result: EntityReminderResult,
): Promise<void> {
  await prisma.loanNote.create({
    data: {
      tenantId,
      loanId: loan.id,
      type,
      note: `Automated reminder to the directors, trustees and authorised signatories of ${loan.entityName}: ${result.namedSummary}`,
      createdBy: "system",
    },
  })
}
