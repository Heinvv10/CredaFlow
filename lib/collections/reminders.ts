/**
 * Payment Reminder Cron — checks active loans and sends reminders based on due dates.
 *
 * Flag-gated cutover. When MESSAGING_NEW_SEND_COLLECTIONS=true,
 * sends route through lib/messaging/sendMessage() (channel-aware provider routing
 * + Message row + Conversation thread + audit trail). When the flag is unset
 * or "false", the legacy direct sendSms/sendWhatsApp path runs unchanged.
 *
 * The trigger schedule + verbatim message text live in the TRIGGERS array
 * below — preserved verbatim from pre-cutover so the cover legal voice and
 * cadence are unchanged. On the new-send path the SMS leg passes the rendered
 * message as a {{body}} var to `payment_reminder_sms`, a literal `{{body}}`
 * passthrough. The WhatsApp leg cannot: Meta rejects a body that is only a
 * parameter, so outside the 24h window every reminder failed
 * WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE. Each WhatsApp trigger instead sends its
 * own row (`<waTemplateEvent>_whatsapp`) with discrete named vars — bodies in
 * lib/whatsapp/template-vars.ts.
 */

import { prisma } from "@/lib/prisma"
import { sendSms, sendWhatsApp } from "@/lib/integrations/bulksms"
import { triggerNotification } from "@/lib/notifications"
import { escapeHtml, formatZAR } from "@/lib/utils"
import { getLenderIdentity } from "@/lib/config/identity"
import { isCollectionsNewSendEnabled } from "@/lib/messaging/flags"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import { lookupContactByChannelValue, normaliseEmail, normalisePhone, toWaJid } from "@/lib/contact/identity"
import { sweepActiveTenants, tenantFailureDetail, type SweepTenant } from "@/lib/collections/tenant-sweep"
import type { MessageTemplate, MsgStatus } from "@prisma/client"
import { sastCalendarDate, sastStartOfDay } from "@/lib/date/sast"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"
import { waTemplateVarsFor } from "@/lib/whatsapp/template-vars"
import { renderTemplate } from "@/lib/messaging/render"
import { recordEntityReminder, sendEntityReminder, type EntityReminderLoan } from "@/lib/asset-finance/entity-reminders"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"
import { isLoanHeld } from "@/lib/collections/client-holds"

export type ReminderDeliveryOutcome =
  | "sent"
  | "simulated"
  | "pending"
  | "suppressed"
  | "failed"

export function reminderDeliveryOutcome(status: MsgStatus): ReminderDeliveryOutcome {
  switch (status) {
    case "SENT":
    case "DELIVERED":
    case "READ":
      return "sent"
    case "SIMULATED":
      return "simulated"
    case "QUEUED":
    case "RETRYING":
      return "pending"
    case "SUPPRESSED_BY_CONSENT":
      return "suppressed"
    case "FAILED":
    case "FAILED_PERMANENT":
    case "EXPIRED":
    case "BOUNCED":
      return "failed"
  }
  const unhandled: never = status
  return unhandled
}

interface ReminderResult {
  sent: number
  simulated: number
  reconciliationRequired: number
  /** SMS legs not dispatched because the channel is off. Not an error. */
  smsChannelOff: number
  errors: number
  details: string[]
}

interface ReminderTrigger {
  daysUntilDue: number
  noteType: string
  /** "email" is sent through sendMessage on every path, whatever the new-send flag says. */
  channels: Array<"sms" | "whatsapp" | "email">
  getMessage: (ctx: MessageContext) => string
  /** The email leg's subject and, where the SMS copy does not suit an email, its text. */
  emailSubject?: (ctx: MessageContext) => string
  emailText?: (ctx: MessageContext) => string
  /** WABA_BODY_TEMPLATES event the WhatsApp leg sends. Required when
   *  `channels` includes "whatsapp". */
  waTemplateEvent?: string
  /** A newer body for the same leg, sent instead only once Meta has APPROVED
   *  it for the tenant — never a silent switch off an approved template. */
  waTemplateSuccessor?: string
}

interface MessageContext {
  firstName: string
  amount: string
  date: string
  loanRef: string
  arrearsAmount: string
  lenderName: string
  phone: string
}

export const TRIGGERS: ReminderTrigger[] = [
  {
    daysUntilDue: 7,
    noteType: "reminder_7d",
    channels: ["sms", "whatsapp", "email"],
    waTemplateEvent: "payment_reminder_7d",
    emailSubject: (ctx) => `Payment reminder: ${ctx.amount} due on ${ctx.date}`,
    emailText: (ctx) =>
      `Hi ${ctx.firstName}, your loan payment of ${ctx.amount} is due on ${ctx.date}. Ref: ${ctx.loanRef}. Need help? Contact ${ctx.lenderName} on ${ctx.phone}.`,
    getMessage: (ctx) =>
      `Hi ${ctx.firstName}, your loan payment of ${ctx.amount} is due on ${ctx.date}. Ref: ${ctx.loanRef}. Reply STOP to opt out.`,
  },
  {
    daysUntilDue: 1,
    noteType: "reminder_1d",
    channels: ["sms", "whatsapp", "email"],
    waTemplateEvent: "payment_reminder_1d",
    emailSubject: (ctx) => `Payment due tomorrow: ${ctx.amount} on ${ctx.loanRef}`,
    getMessage: (ctx) =>
      `Reminder: ${ctx.amount} due TOMORROW (${ctx.date}) on loan ${ctx.loanRef}. Please ensure funds are available. ${ctx.lenderName}`,
  },
  {
    daysUntilDue: 0,
    noteType: "reminder_0d",
    channels: ["sms", "whatsapp", "email"],
    waTemplateEvent: "payment_reminder_0d",
    emailSubject: (ctx) => `Payment due today: ${ctx.amount} on ${ctx.loanRef}`,
    waTemplateSuccessor: "payment_reminder_0d_v3",
    getMessage: (ctx) =>
      `Your loan payment of ${ctx.amount} is due today. Ref: ${ctx.loanRef}. Need help? Contact ${ctx.lenderName} on ${ctx.phone}.`,
  },
  {
    daysUntilDue: -1,
    noteType: "reminder_overdue_1d",
    channels: ["sms", "whatsapp"],
    waTemplateEvent: "payment_reminder_overdue_1d",
    getMessage: (ctx) =>
      `URGENT: Your payment of ${ctx.amount} on loan ${ctx.loanRef} was due yesterday. Please pay immediately to avoid additional charges.`,
  },
  {
    daysUntilDue: -3,
    noteType: "reminder_overdue_3d",
    channels: ["sms", "whatsapp"],
    waTemplateEvent: "payment_reminder_overdue_3d",
    getMessage: (ctx) =>
      `IMPORTANT: Loan ${ctx.loanRef} is 3 days overdue. Outstanding: ${ctx.arrearsAmount}. Contact us immediately: ${ctx.phone}`,
  },
]

/**
 * Why `loan_overdue`'s WhatsApp leg must be dropped for this trigger, or
 * undefined when there is nothing to drop.
 *
 * Every trigger with `daysUntilDue < 0` also fires the `loan_overdue`
 * notification, whose WhatsApp leg sends `loan_overdue_1d`. Where that
 * trigger ALSO has its own WhatsApp leg, the borrower gets two dunning
 * WhatsApps the same morning.
 *
 * DERIVED from the trigger's own `channels`, never from a list of offsets:
 * a hardcoded `-1, -3` silently reintroduces the duplicate the day a trigger
 * is added, and silently suppresses a legitimate notice the day one loses its
 * WhatsApp leg.
 *
 * Scope is deliberately the leg, not the event. `loan_overdue` also carries
 * the "Payment Overdue Notice" EMAIL, which no reminder stage sends at all —
 * suppressing the event would take that email away from the borrower.
 *
 * CHOSEN, not forced: this asks by DESIGN (does the stage carry WhatsApp?),
 * not by outcome. The stage's own result is in scope at the call site
 * (`channelsSent`), so `suppress only if channelsSent.includes("whatsapp")`
 * is available — it is not taken because a QUEUED or reconciliation-pending
 * leg would then reinstate `loan_overdue`'s WhatsApp and reintroduce the
 * duplicate this exists to prevent. The cost of the choice: if the stage's
 * own WABA row is missing, its leg is blocked and `loan_overdue`'s is
 * suppressed, so no WhatsApp goes out — the borrower still gets the email,
 * and the missing row is already a loud per-loan error.
 */
export function overdueWhatsAppSuppressionReason(
  trigger: Pick<ReminderTrigger, "noteType" | "channels">,
): string | undefined {
  if (!trigger.channels.includes("whatsapp")) return undefined
  return `the ${trigger.noteType} reminder stage already sends a WhatsApp at this offset`
}

function startOfDay(d: Date): Date {
  return sastStartOfDay(d)
}

/**
 * The day this send is reserved against, as a SAST calendar date.
 *
 * It was built from LOCAL date parts on a UTC container, so the "already
 * reminded today" window rolled over at 02:00 SAST rather than midnight. A
 * reminder sent at 00:30 was filed under the previous day and could be sent
 * again the same morning — the borrower gets the same overdue notice twice
 * before breakfast. Note this shape is invisible to a guard that only inspects
 * date CONSTRUCTORS: nothing here builds a Date at all.
 */
function localDayKey(d: Date): string {
  return sastCalendarDate(d)
}

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 86_400_000
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / msPerDay)
}

async function alreadyProcessedToday(loanId: string, noteType: string, tenantId: string): Promise<boolean> {
  const todayStart = startOfDay(new Date())
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayEnd.getDate() + 1)

  const existing = await prisma.loanNote.findFirst({
    where: {
      tenantId,
      loanId,
      type: noteType,
      createdAt: { gte: todayStart, lt: todayEnd },
    },
  })
  return !!existing
}

/**
 * One trigger for an entity-borrower loan: its WhatsApp leg to every person
 * who acts for the entity (never SMS), the trigger's LoanNote when a leg went
 * out, and, on an overdue trigger, the `loan_overdue` notification (email to
 * the same people) exactly as for a consumer.
 */
async function remindEntityTrigger(args: {
  tenantId: string
  loan: EntityReminderLoan
  trigger: ReminderTrigger
  dueDate: Date
  today: Date
  paymentAmount: number
  charges: number
  arrearsDue: number
  lender: { tradingName: string; collectionsPhone: string }
  result: ReminderResult
}): Promise<void> {
  const { loan, trigger, result } = args
  const overdue = trigger.daysUntilDue < 0
  if (trigger.channels.includes("whatsapp")) {
    const sent = await sendEntityReminder({
      tenantId: args.tenantId,
      loan,
      kind: overdue ? "overdue" : "due",
      amountCents: overdue ? args.arrearsDue : args.paymentAmount + args.charges,
      dueDate: args.dueDate,
      daysOverdue: overdue ? -trigger.daysUntilDue : undefined,
      lender: args.lender,
      // The pre-due triggers also email the people who act for the entity; an
      // overdue one reaches them by email through loan_overdue below.
      channels: overdue ? ["WHATSAPP"] : ["WHATSAPP", "EMAIL"],
      occurrence: `${trigger.noteType}:${localDayKey(args.today)}`,
      category: "collections",
    })
    if (sent.reached) {
      result.sent++
      await recordEntityReminder(args.tenantId, loan, trigger.noteType, sent)
    }
    if (sent.failed) result.errors++
    result.details.push(`Entity ${trigger.noteType} for ${loan.reference} (${loan.entityName}): ${sent.summary}`)
  }
  if (overdue) {
    // Awaited, unlike the consumer call, so a failure lands in this run's report.
    try {
      await triggerNotification({
        tenantId: args.tenantId,
        event: "loan_overdue",
        loanId: loan.id,
        data: { daysOverdue: Math.abs(trigger.daysUntilDue), amount: args.arrearsDue },
        suppressWhatsAppReason: overdueWhatsAppSuppressionReason(trigger),
      })
    } catch (err) {
      result.errors++
      result.details.push(`Error ${loan.reference} loan_overdue: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export async function processPaymentReminders(): Promise<ReminderResult> {
  // The reminders cron runs without a request (cron-secret auth on
  // app/api/cron/reminders/route.ts, or the in-process scheduler), so it opens
  // each ACTIVE tenant's own frame (lib/collections/tenant-sweep.ts). Without a
  // frame the per-tenant-scoped Prisma extension cannot inject tenantId into the
  // queries sendMessage() makes on its own (Message updates without a
  // where:tenantId): it would throw TenantScopeError on every successful
  // dispatch, leaving rows stuck in QUEUED and ops unable to tell delivered
  // from undelivered.
  const total: ReminderResult = { sent: 0, simulated: 0, reconciliationRequired: 0, smsChannelOff: 0, errors: 0, details: [] }
  const outcomes = await sweepActiveTenants("reminders", (tenant) => processTenantReminders(tenant))
  if (outcomes.length === 0) total.details.push("No active tenant found")
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.errors++
      total.details.push(tenantFailureDetail(outcome.tenant, outcome.error))
      continue
    }
    const r = outcome.value
    total.sent += r.sent
    total.simulated += r.simulated
    total.reconciliationRequired += r.reconciliationRequired
    total.smsChannelOff += r.smsChannelOff
    total.errors += r.errors
    total.details.push(...r.details)
  }
  return total
}

async function processTenantReminders(tenant: SweepTenant): Promise<ReminderResult> {
  const result: ReminderResult = { sent: 0, simulated: 0, reconciliationRequired: 0, smsChannelOff: 0, errors: 0, details: [] }

  // Counted per trigger and reported ONCE at the end of the run, not as a
  // detail line per loan. An SMS-only trigger writes no LoanNote (there was no
  // contact to record), so alreadyProcessedToday() cannot suppress it on the
  // next tick — a per-loan line would therefore reprint for every matching
  // loan on every run for as long as SMS stays off. The aggregate stays
  // visible without growing the log without bound.
  const smsOffByTrigger = new Map<string, number>()

  // Same bounded-aggregate treatment, for the same reason: neither of these
  // skips writes a LoanNote, so alreadyProcessedToday() cannot suppress them
  // and a per-loan detail line would reprint every run, for every loan, for
  // as long as the condition holds.
  //
  // `noLegDispatchedByTrigger` counts a (loan, trigger) pair that was DUE
  // and on which no leg was DISPATCHED at all — every leg skipped, before any
  // provider was called.
  //
  // It deliberately does NOT mean "nobody was reached". A leg that WAS
  // dispatched and then came back FAILED / FAILED_PERMANENT /
  // SUPPRESSED_BY_CONSENT, or threw SendBlockedError, does not count here:
  // something was attempted, and that outcome is carried by `result.errors`
  // and the "Failed ..." / "Not sent ..." detail lines. A WhatsApp leg
  // whose WABA template is not yet approved produces only FAILED_PERMANENT,
  // so a zero here could be read as
  // "everyone was reached" when in fact nobody was. Hence the name, and the
  // wording of the line it prints.
  const noWaNumberByTrigger = new Map<string, number>()
  const noEmailByTrigger = new Map<string, number>()
  const noLegDispatchedByTrigger = new Map<string, number>()

  const newSend = isCollectionsNewSendEnabled()

  // Hoist template lookups once when the flag is on. A missing SMS template
  // aborts the cron (a missing WhatsApp row blocks only its leg — below) with
  // a clear surface-level error — we deliberately do not fall
  // back to the legacy path silently, because that would mask a deployment
  // mistake (operator flips the flag without applying the migration).
  // active=true: a disabled template is a signal it's under revision; never
  // dispatch against it. statutoryOverride is asserted false post-lookup —
  // collections reminders are SERVICE category and must run through the
  // consent + block-status gate.
  let templateSms: MessageTemplate | null = null
  // One WhatsApp row per trigger, keyed by noteType. A trigger whose row is
  // unusable is in `waTemplateProblems` instead: that blocks ONLY its WhatsApp
  // leg (per loan, counted as an error), never the cron or the SMS leg — so
  // a tenant without its WhatsApp reminder rows degrades WhatsApp alone.
  const templatesWa: Record<string, MessageTemplate> = {}
  const waTemplateProblems: Record<string, string> = {}
  if (newSend) {
    templateSms = await prisma.messageTemplate.findFirst({
      where: { tenantId: tenant.id, key: "payment_reminder_sms", channel: "SMS", active: true },
    })
    if (!templateSms) {
      result.errors++
      result.details.push(
        "Aborting cron: MESSAGING_NEW_SEND_COLLECTIONS=true but payment_reminder_sms template missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts) before flipping the flag",
      )
      return result
    }
    if (templateSms.statutoryOverride !== false) {
      result.errors++
      result.details.push(
        "Aborting cron: payment_reminder template has statutoryOverride=true — collections reminders are SERVICE category and must NOT bypass eligibility",
      )
      return result
    }
    for (const trigger of TRIGGERS) {
      if (!trigger.waTemplateEvent) continue
      const successor = trigger.waTemplateSuccessor
        ? await prisma.messageTemplate.findFirst({
            where: { tenantId: tenant.id, key: `${trigger.waTemplateSuccessor}_whatsapp`, channel: "WHATSAPP", active: true },
          })
        : null
      const key = successor?.providerStatus === "APPROVED"
        ? `${trigger.waTemplateSuccessor}_whatsapp`
        : `${trigger.waTemplateEvent}_whatsapp`
      const tpl = successor?.providerStatus === "APPROVED"
        ? successor
        : await prisma.messageTemplate.findFirst({
            where: { tenantId: tenant.id, key, channel: "WHATSAPP", active: true },
          })
      if (!tpl) {
        waTemplateProblems[trigger.noteType] =
          `template ${key} missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)`
      } else if (tpl.statutoryOverride !== false) {
        waTemplateProblems[trigger.noteType] =
          `template ${key} has statutoryOverride=true — collections reminders must NOT bypass eligibility`
      } else {
        templatesWa[trigger.noteType] = tpl
      }
    }
  }

  // The email leg goes through sendMessage whatever the new-send flag says, so
  // its template is checked on every path. A tenant without the row (seed the
  // default templates) has that leg reported per loan, never sent without one.
  const templateEmail = await prisma.messageTemplate.findFirst({
    where: { tenantId: tenant.id, key: "payment_reminder_email", channel: "EMAIL", active: true },
  })
  const emailTemplateProblem = !templateEmail
    ? "template payment_reminder_email missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)"
    : templateEmail.statutoryOverride !== false
      ? "template payment_reminder_email has statutoryOverride=true — collections reminders must NOT bypass eligibility"
      : null

  const loans = await prisma.loan.findMany({
    where: {
      tenantId: tenant.id,
      // Status ACTIVE and every dunning hold (lib/collections/dunning-holds.ts).
      ...remindableLoanWhere(),
      nextPaymentDate: { not: null },
    },
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          whatsapp: true,
          email: true,
        },
      },
      entity: { select: { legalName: true } },
    },
  })

  // Throws LenderIdentityError when the tenant's identity is not configured:
  // no reminder goes out signed with a default name or phone number.
  const identity = await getLenderIdentity(tenant.id)
  const lenderName = identity.tradingName
  const companyPhone = identity.collectionsPhone

  for (const loan of loans) {
    const today = new Date()
    const dueDate = loan.nextPaymentDate!
    const daysUntil = daysBetween(today, dueDate)

    // Find next unpaid schedule entry for amount. `totalDue > 0` skips an
    // asset-finance skip period's R0.00 row, which stays PENDING for good
    // (lib/asset-finance/schedule-records.ts); a consumer row is never zero.
    // PARTIAL is unpaid too: leaving it out quoted "R 0.00" to borrowers whose
    // unpaid rows a writer had stored PARTIAL.
    const nextSchedule = await prisma.repaymentSchedule.findFirst({
      where: { loanId: loan.id, tenantId: tenant.id, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, totalDue: { gt: 0 } },
      orderBy: { dueDate: "asc" },
      select: { totalDue: true, totalPaid: true },
    })
    const paymentAmount = nextSchedule ? Math.max(0, nextSchedule.totalDue - nextSchedule.totalPaid) : 0

    for (const trigger of TRIGGERS) {
      if (daysUntil !== trigger.daysUntilDue) continue

      const processed = await alreadyProcessedToday(loan.id, trigger.noteType, tenant.id)
      if (processed) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType} already processed today`)
        continue
      }

      // The loans were selected at the start of the run, which can be long: a
      // debt-review notice, a death or an arrangement recorded since then must
      // stop this send. Checked per send, immediately before it.
      if (await isLoanHeld({ tenantId: tenant.id, loanId: loan.id })) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType}, the loan or client was put on a dunning hold during this run`)
        continue
      }

      // What the borrower must pay now includes default charges outstanding
      // (0 while the tenant's flag is off, so the copy is unchanged).
      const charges = await chargesOutstandingAt(prisma, { tenantId: tenant.id, loanId: loan.id }, today)
      const arrearsDue = loan.arrearsAmount + charges

      // Never tell a borrower they owe R 0.00: nothing unpaid on the schedule,
      // or an overdue trigger on a loan with no arrears, is no reminder at all.
      if (paymentAmount + charges <= 0 || (trigger.daysUntilDue < 0 && arrearsDue <= 0)) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType}, nothing owed`)
        continue
      }

      // An entity borrower (asset finance) has no Client to message: the
      // trigger's WhatsApp leg goes to the people who act for it instead, in
      // copy that names the entity (lib/asset-finance/entity-reminders.ts). Its
      // regime is not the reason; NON_NCA loans are reminded like any other.
      if (!loan.client) {
        if (!loan.entityId || !loan.entity) continue
        await remindEntityTrigger({
          tenantId: tenant.id,
          loan: { id: loan.id, reference: loan.reference, entityId: loan.entityId, entityName: loan.entity.legalName },
          trigger, dueDate, today, paymentAmount, charges, arrearsDue,
          lender: { tradingName: lenderName, collectionsPhone: companyPhone },
          result,
        })
        continue
      }

      const ctx: MessageContext = {
        firstName: loan.client.firstName,
        amount: formatZAR(paymentAmount + charges),
        date: dueDate.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }),
        loanRef: loan.reference,
        arrearsAmount: formatZAR(arrearsDue),
        lenderName,
        phone: companyPhone,
      }

      const message = trigger.getMessage(ctx)
      const emailText = trigger.emailText ? trigger.emailText(ctx) : message
      const channelsSent: string[] = []
      const channelsSimulated: string[] = []
      const channelsReconciliation: string[] = []
      const channelsPending: string[] = []
      const channelsSuppressed: string[] = []
      const channelsFailed: string[] = []
      const sentText: Record<string, string> = {}
      // Per (loan, trigger) reach accounting, read after the channel loop.
      // `dispatched` flips the moment any leg actually reaches a provider
      // call, so "no leg was dispatched" is observed, not inferred from the
      // skip reasons. It says nothing about the OUTCOME of that call.
      let dispatched = false

      for (const channel of trigger.channels) {
        // SMS channel off. Skipped BEFORE either dispatch path so no Message
        // row is written and no LoanNote can name a channel that carried
        // nothing. Not an error — the channel is off by configuration, which
        // is a policy outcome like a consent block, not a fault. The
        // WhatsApp leg of the same trigger is untouched.
        if (channel === "sms" && !isSmsChannelEnabled()) {
          result.smsChannelOff++
          smsOffByTrigger.set(trigger.noteType, (smsOffByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        // WhatsApp policy: opportunistic. If the client doesn't have a
        // dedicated whatsapp number on file we DON'T fall back to their SMS
        // number — most clients with `whatsapp=null` simply aren't on
        // WhatsApp, and WhatsApping a number that is not on WhatsApp is a
        // delivery failure at best. On the new path a fallback would also
        // generate "no Contact row" errors for every loan with only a phone.
        //
        // This gate sits OUTSIDE the newSend branch on purpose. The legacy
        // branch used to send to `client.whatsapp ?? client.phone`, so on a
        // flag-off environment a borrower with no WhatsApp got WhatsApped on
        // their plain phone number. Both paths now agree.
        //
        // Counted, not logged per loan: the skip writes no LoanNote, so
        // alreadyProcessedToday() cannot suppress it next tick and a per-loan
        // line would reprint for every matching loan on every run. One
        // aggregate at the end of the run, like the SMS-off accounting.
        if (channel === "whatsapp" && !loan.client.whatsapp) {
          noWaNumberByTrigger.set(trigger.noteType, (noWaNumberByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        if (channel === "email" && !loan.client.email) {
          noEmailByTrigger.set(trigger.noteType, (noEmailByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        if (newSend || channel === "email") {
          // New path: route through sendMessage(). Channel-keyed Contact
          // lookup, eligibility check (consent + block-status), Message
          // row + Conversation thread + audit trail.
          if (channel === "whatsapp" && waTemplateProblems[trigger.noteType]) {
            result.errors++
            result.details.push(
              `Blocked ${trigger.noteType} for ${loan.reference} via whatsapp: ${waTemplateProblems[trigger.noteType]}`,
            )
            continue
          }
          if (channel === "email" && emailTemplateProblem) {
            result.errors++
            result.details.push(`Blocked ${trigger.noteType} for ${loan.reference} via email: ${emailTemplateProblem}`)
            continue
          }
          const rawPhone = channel === "whatsapp" ? loan.client.whatsapp! : channel === "email" ? loan.client.email! : loan.client.phone
          if (!rawPhone) {
            result.errors++
            result.details.push(`Error ${loan.reference} ${channel}: no phone on file`)
            continue
          }
          const channelEnum = channel === "whatsapp" ? "WHATSAPP" : channel === "email" ? "EMAIL" : "SMS"
          const value = channel === "whatsapp" ? toWaJid(rawPhone) : channel === "email" ? normaliseEmail(rawPhone) : normalisePhone(rawPhone)
          if (!value) {
            result.errors++
            result.details.push(`Error ${loan.reference} ${channel}: unparseable phone "${rawPhone}"`)
            continue
          }
          const contact = await lookupContactByChannelValue(prisma, {
            tenantId: tenant.id,
            channel: channelEnum,
            value,
          })
          if (!contact) {
            // Data drift: Client without a ContactIdentity row for this
            // channel. Surface the gap — don't silently drop. Operator
            // backfills then re-runs.
            result.errors++
            result.details.push(`Error ${loan.reference} ${channel}: no Contact row for ${value}`)
            continue
          }
          const template = channel === "whatsapp" ? templatesWa[trigger.noteType] : channel === "email" ? templateEmail! : templateSms!
          // WhatsApp: the discrete named vars its WABA body declares, from the
          // same ctx the SMS copy interpolates, so both quote one set of figures.
          const vars = channel === "whatsapp"
            ? waTemplateVarsFor(trigger.waTemplateEvent!, {
                firstName: ctx.firstName,
                reference: ctx.loanRef,
                amount: ctx.amount,
                outstanding: ctx.arrearsAmount,
                dueDate: ctx.date,
                supportPhone: ctx.phone,
              })
            : channel === "email"
              ? { subject: trigger.emailSubject!(ctx), text: emailText, html: `<p>${escapeHtml(emailText)}</p>` }
              : { body: message }
          try {
            // What this channel actually carries, for the LoanNote: the
            // WhatsApp leg sends its row's body, not the SMS text. Rendered
            // inside the try — sendMessage renders the same and would throw
            // the same on an absent var.
            sentText[channel] = renderTemplate(template, vars).text
            dispatched = true
            const sendResult = await sendMessage({
              contactId: contact.id,
              channel: channelEnum,
              template,
              vars,
              toValue: value,
              category: "collections",
              loanId: loan.id,
              idempotencyKey: `collections:${loan.id}:${trigger.noteType}:${channelEnum}:${localDayKey(today)}`,
            })
            const deliveryOutcome = reminderDeliveryOutcome(sendResult.status)
            if (deliveryOutcome === "sent") channelsSent.push(channel)
            else if (deliveryOutcome === "simulated") channelsSimulated.push(channel)
            else if (deliveryOutcome === "pending") channelsPending.push(channel)
            else if (deliveryOutcome === "suppressed") {
              channelsSuppressed.push(`${channel} (${sendResult.status})`)
            } else {
              channelsFailed.push(`${channel} (${sendResult.status})`)
              result.errors++
            }
          } catch (err) {
            if (err instanceof SendBlockedError) {
              // Consent / BLOCKED / channel-opt-out — correct behaviour,
              // not a runtime error. Record but don't bump errors.
              result.details.push(`Skip ${loan.reference} ${channel}: blocked (${err.message})`)
            } else if (err instanceof KnownDispatchPersistenceError) {
              const evidence = knownDispatchEvidenceFromError(err)
              channelsReconciliation.push(channel)
              result.details.push(
                `Reconciliation required ${loan.reference} ${channel}: message ${err.messageRecord.id}; known evidence ${JSON.stringify(evidence)}; automatic replay blocked`,
              )
            } else if (err instanceof MessageReconciliationRequiredError) {
              channelsReconciliation.push(channel)
              result.details.push(
                `Reconciliation required ${loan.reference} ${channel}: message ${err.messageRecord.id}; automatic replay blocked`,
              )
            } else {
              result.errors++
              const msg = err instanceof Error ? err.message : String(err)
              result.details.push(`Error ${loan.reference} ${channel}: ${msg}`)
            }
          }
        } else {
          // Legacy path: direct sendSms / sendWhatsApp via BulkSMS gateway.
          // Kept until the new path has soaked with the flag on.
          // `loan.client.whatsapp` is non-null here: the shared gate above
          // skipped the leg otherwise. It used to read `?? loan.client.phone`.
          const sendFn = channel === "whatsapp" ? sendWhatsApp : sendSms
          dispatched = true
          const sendResult = await sendFn({
            tenantId: tenant.id,
            to: channel === "whatsapp" ? loan.client.whatsapp! : loan.client.phone,
            message,
          })
          if (sendResult.ok) {
            if (sendResult.simulated) channelsSimulated.push(channel)
            else channelsSent.push(channel)
          } else {
            result.errors++
            result.details.push(`Error ${loan.reference} ${channel}: ${sendResult.error}`)
          }
        }
      }

      if (channelsSent.length > 0 || channelsSimulated.length > 0 || channelsReconciliation.length > 0) {
        if (channelsSent.length > 0) result.sent++
        if (channelsSimulated.length > 0) result.simulated++
        if (channelsReconciliation.length > 0) result.reconciliationRequired++
        const channelLabel = channelsSent.join("+")
        const simulatedChannelLabel = channelsSimulated.join("+")
        const reconciliationChannelLabel = channelsReconciliation.join("+")
        // Quote what each recorded channel carried. One text when they agree
        // (always, on the legacy path); per channel when they differ, since the
        // WhatsApp leg sends its template row's body, not the SMS copy.
        const noted = [...channelsSent, ...channelsSimulated, ...channelsReconciliation]
        const texts = noted.map((ch) => sentText[ch] ?? message)
        const quoted = new Set(texts).size <= 1
          ? `"${texts[0] ?? message}"`
          : noted.map((ch, i) => `${ch}: "${texts[i]}"`).join("; ")
        const note = channelsSent.length > 0
          ? `Automated reminder sent via ${channelLabel}${channelsSimulated.length > 0 ? `; simulated (not sent) via ${simulatedChannelLabel}` : ""}${channelsReconciliation.length > 0 ? `; delivery uncertain and held for reconciliation via ${reconciliationChannelLabel}` : ""}: ${quoted}`
          : channelsSimulated.length > 0
            ? `Automated reminder simulated (not sent) via ${simulatedChannelLabel}${channelsReconciliation.length > 0 ? `; delivery uncertain and held for reconciliation via ${reconciliationChannelLabel}` : ""}: ${quoted}`
            : `Automated reminder delivery uncertain via ${reconciliationChannelLabel}; held for manual reconciliation and automatic replay blocked: ${quoted}`
        await prisma.loanNote.create({
          data: {
            tenantId: tenant.id,
            loanId: loan.id,
            type: trigger.noteType,
            note,
            createdBy: "system",
          },
        })
        if (channelsSent.length > 0) {
          result.details.push(`Sent ${trigger.noteType} to ${loan.reference} via ${channelLabel}`)
        }
        if (channelsSimulated.length > 0) {
          result.details.push(`Simulated ${trigger.noteType} for ${loan.reference} via ${simulatedChannelLabel} (not sent)`)
        }
        if (channelsReconciliation.length > 0) {
          result.details.push(`Held ${trigger.noteType} for ${loan.reference} via ${reconciliationChannelLabel}; reconciliation required`)
        }
      }
      if (channelsPending.length > 0) {
        result.details.push(
          `Skip duplicate ${trigger.noteType} for ${loan.reference} via ${channelsPending.join("+")}: durable business reservation already active`,
        )
      }
      if (channelsSuppressed.length > 0) {
        result.details.push(
          `Not sent ${trigger.noteType} for ${loan.reference} via ${channelsSuppressed.join("+")}: consent suppression is terminal`,
        )
      }
      if (channelsFailed.length > 0) {
        result.details.push(
          `Failed ${trigger.noteType} for ${loan.reference} via ${channelsFailed.join("+")}: terminal message outcome; operator action required`,
        )
      }

      // No leg of a DUE trigger reached a provider at all, whatever the
      // reason: a policy skip (SMS off, no WhatsApp number) or a pre-dispatch
      // fault (no Contact row, unusable template). Faults are separately
      // counted in `result.errors`, but a leg that never left the building
      // never left the building either way, so the count must not exclude
      // them — ANDing in a "was any leg skipped by policy" clause would
      // under-report exactly that case.
      if (!dispatched) {
        noLegDispatchedByTrigger.set(
          trigger.noteType,
          (noLegDispatchedByTrigger.get(trigger.noteType) ?? 0) + 1,
        )
      }

      // Trigger overdue notification for overdue triggers
      if (trigger.daysUntilDue < 0) {
        triggerNotification({
          tenantId: tenant.id,
          event: "loan_overdue",
          loanId: loan.id,
          clientId: loan.client.id,
          data: { daysOverdue: Math.abs(trigger.daysUntilDue), amount: arrearsDue },
          // The event still fires — email and the NotificationLog record are
          // unchanged. Only the WhatsApp leg is dropped, and only where this
          // trigger's own stage already carries one.
          suppressWhatsAppReason: overdueWhatsAppSuppressionReason(trigger),
        }).catch(() => {})
      }
    }
  }

  const tally = (m: Map<string, number>) =>
    [...m.entries()].map(([noteType, count]) => `${noteType} x${count}`).join(", ")
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  if (result.smsChannelOff > 0) {
    const breakdown = tally(smsOffByTrigger)
    // COMPUTED from TRIGGERS, never asserted. This line once named
    // reminder_7d and reminder_overdue_1d as SMS-only; both now carry a
    // WhatsApp leg, and a hardcoded sentence would have kept telling ops that
    // those borrowers went unreached. Derive it, and it comes back by itself
    // the day a trigger loses its WhatsApp leg.
    const unreachable = [...smsOffByTrigger.keys()].filter(
      (noteType) => !TRIGGERS.find((t) => t.noteType === noteType)?.channels.includes("whatsapp"),
    )
    const consequence = unreachable.length > 0
      ? `${unreachable.join(" and ")} ${unreachable.length > 1 ? "are" : "is"} SMS-only, so those borrowers were not reminded at all.`
      : `Every blocked trigger also has a WhatsApp leg; whether that leg reached anyone is the lines below, not this one.`
    result.details.push(
      `Blocked ${result.smsChannelOff} sms leg(s) this run: ${SMS_CHANNEL_OFF_REASON} (${breakdown}). ${consequence}`,
    )
  }

  if (total(noEmailByTrigger) > 0) {
    result.details.push(
      `Skipped ${total(noEmailByTrigger)} email leg(s) this run: no email address on file (${tally(noEmailByTrigger)}).`,
    )
  }

  if (total(noWaNumberByTrigger) > 0) {
    result.details.push(
      `Skipped ${total(noWaNumberByTrigger)} whatsapp leg(s) this run: no WhatsApp number on file (${tally(noWaNumberByTrigger)}).`,
    )
  }

  // Said out loud rather than left to be inferred from the two lines above.
  // The second sentence is load-bearing: a ZERO on this line is not "everyone
  // was reached" — a leg that was dispatched and then failed at the provider
  // is not counted here.
  if (total(noLegDispatchedByTrigger) > 0) {
    result.details.push(
      `${total(noLegDispatchedByTrigger)} borrower reminder(s) had NO leg dispatched this run (${tally(noLegDispatchedByTrigger)}). `
        + `Counts legs that never reached a provider; a dispatched leg that then FAILED is in the error lines, not here.`,
    )
  }

  return result
}
