/**
 * Payment Reminder Cron — checks active loans and sends reminders based on due dates.
 *
 * Every reminder leg (SMS, WhatsApp, the pre-due email, every entity leg) is
 * sent through lib/messaging/sendMessage() (consent and block gate, WhatsApp kill
 * switches, channel-aware provider routing, Message row with `dunning` set,
 * Conversation thread, audit trail). There is no other path: the direct BulkSMS
 * leg that used to run while MESSAGING_NEW_SEND_COLLECTIONS was unset had no
 * opt-out, block or kill-switch gate, and was retired. Each leg's once-per-day
 * reservation is sendMessage's idempotency key: a Message row committed under a
 * database-unique key before the provider is called, so an overlapping run gets
 * the existing row back instead of sending again.
 *
 * The trigger schedule + verbatim message text live in the TRIGGERS array
 * below — preserved verbatim from pre-cutover so the cover legal voice and
 * cadence are unchanged. The SMS leg passes the rendered
 * message as a {{body}} var to `payment_reminder_sms`, a literal `{{body}}`
 * passthrough. The WhatsApp leg cannot: Meta rejects a body that is only a
 * parameter, so outside the 24h window every reminder failed
 * WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE. Each WhatsApp trigger instead sends its
 * own row (`<waTemplateEvent>_whatsapp`) with discrete named vars — bodies in
 * lib/whatsapp/template-vars.ts.
 */

import { prisma } from "@/lib/prisma"
import { escapeHtml, formatDate, formatZAR } from "@/lib/utils"
import { getLenderIdentity } from "@/lib/config/identity"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import { WA_SETTINGS_UNAVAILABLE_REASON, whatsappRefusalForTenant } from "@/lib/whatsapp/kill-switch"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import { normaliseEmail, normalisePhone, toWaJid } from "@/lib/contact/identity"
import { lookupRecipientContact } from "@/lib/contact/recipient"
import { ensureDpdCurrent } from "@/lib/loan/dpd-update"
import { isDatabaseInfrastructureError } from "@/lib/ops/db-fault"
import { ensureDunningTemplates } from "@/lib/collections/dunning-templates"
import { fireOverdueNotice } from "@/lib/collections/overdue-notice"
import { DUNNING_SEND_WINDOW_LABEL, outsideDunningSendWindow } from "@/lib/collections/send-window"
import { sweepActiveTenants, tenantFailureDetail, type SweepTenant } from "@/lib/ops/tenant-sweep"
import type { MessageTemplate, MsgStatus } from "@prisma/client"
import { sastCalendarDate, sastStartOfDay } from "@/lib/date/sast"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"
import { waTemplateVarsFor } from "@/lib/whatsapp/template-vars"
import { renderTemplate } from "@/lib/messaging/render"
import { recordEntityReminder, sendEntityReminder, type EntityReminderLoan } from "@/lib/asset-finance/entity-reminders"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"

export { overdueWhatsAppSuppressionReason } from "@/lib/collections/overdue-notice"
import { nextInstalmentOwed, nothingOwed } from "@/lib/collections/amount-owed"
import { isLoanRemindable } from "@/lib/collections/client-holds"
import { REMINDER_DAYS_UNTIL_DUE, sastDaysBetween } from "@/lib/collections/reminder-offsets"

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
  /** WhatsApp legs not dispatched because WhatsApp is off (WA_ENABLED or the tenant switch). Not an error. */
  whatsappChannelOff: number
  /** includes each failed tenant */
  errors: number
  details: string[]
  /** ACTIVE tenants swept, and the ones whose run threw */
  tenants: number
  failedTenants: number
  /** Tenant-level conditions that skipped a leg for the tenant (a missing template or provider). Not errors. */
  warnings: number
  /** Legs the provider refused for now on THIS run: queued for the retry sweep, which sends them inside the window. Not errors. */
  retryScheduled: number
  /** Set when the run refused to start (outside the dunning send window): nothing was looked at or sent. */
  skipped?: string
  /** Loans not reached because the dunning send window closed during the run. Not errors. */
  deferred: number
}

interface ReminderTrigger {
  daysUntilDue: number
  noteType: string
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

/** The consumer and the entity email templates the pre-due email leg needs. */
const EMAIL_LEG_TEMPLATE_KEYS = ["payment_reminder_email", "entity_reminder_email"] as const

export const TRIGGERS: ReminderTrigger[] = [
  {
    daysUntilDue: REMINDER_DAYS_UNTIL_DUE.reminder_7d,
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
    daysUntilDue: REMINDER_DAYS_UNTIL_DUE.reminder_1d,
    noteType: "reminder_1d",
    channels: ["sms", "whatsapp", "email"],
    waTemplateEvent: "payment_reminder_1d",
    emailSubject: (ctx) => `Payment due tomorrow: ${ctx.amount} on ${ctx.loanRef}`,
    getMessage: (ctx) =>
      `Reminder: ${ctx.amount} due TOMORROW (${ctx.date}) on loan ${ctx.loanRef}. Please ensure funds are available. ${ctx.lenderName}`,
  },
  {
    daysUntilDue: REMINDER_DAYS_UNTIL_DUE.reminder_0d,
    noteType: "reminder_0d",
    channels: ["sms", "whatsapp", "email"],
    waTemplateEvent: "payment_reminder_0d",
    emailSubject: (ctx) => `Payment due today: ${ctx.amount} on ${ctx.loanRef}`,
    waTemplateSuccessor: "payment_reminder_0d_v3",
    getMessage: (ctx) =>
      `Your loan payment of ${ctx.amount} is due today. Ref: ${ctx.loanRef}. Need help? Contact ${ctx.lenderName} on ${ctx.phone}.`,
  },
  {
    daysUntilDue: REMINDER_DAYS_UNTIL_DUE.reminder_overdue_1d,
    noteType: "reminder_overdue_1d",
    channels: ["sms", "whatsapp"],
    waTemplateEvent: "payment_reminder_overdue_1d",
    getMessage: (ctx) =>
      `URGENT: Your payment of ${ctx.amount} on loan ${ctx.loanRef} was due yesterday. Please pay immediately to avoid additional charges.`,
  },
  {
    daysUntilDue: REMINDER_DAYS_UNTIL_DUE.reminder_overdue_3d,
    noteType: "reminder_overdue_3d",
    channels: ["sms", "whatsapp"],
    waTemplateEvent: "payment_reminder_overdue_3d",
    getMessage: (ctx) =>
      `IMPORTANT: Loan ${ctx.loanRef} is 3 days overdue. Outstanding: ${ctx.arrearsAmount}. Contact us immediately: ${ctx.phone}`,
  },
]

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
 * who acts for the entity (never SMS), and on a pre-due trigger its email leg,
 * the trigger's LoanNote when a leg went out, and, on an overdue trigger, the
 * `loan_overdue` notification (email to the same people) exactly as for a consumer.
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
  /** False when the tenant cannot send the entity email leg (see entityEmailSkipReason). */
  emailLeg: boolean
  /** WhatsApp is off: the WhatsApp leg is skipped before sendMessage. */
  skipWhatsApp: boolean
  result: ReminderResult
}): Promise<void> {
  const { loan, trigger, result } = args
  const overdue = trigger.daysUntilDue < 0
  const channels: Array<"WHATSAPP" | "EMAIL"> = []
  if (trigger.channels.includes("whatsapp") && !args.skipWhatsApp) channels.push("WHATSAPP")
  // The pre-due triggers also email the people who act for the entity; an
  // overdue one reaches them by email through loan_overdue below.
  if (trigger.channels.includes("email") && !overdue && args.emailLeg) channels.push("EMAIL")
  if (channels.length > 0) {
    const sent = await sendEntityReminder({
      tenantId: args.tenantId,
      loan,
      kind: overdue ? "overdue" : "due",
      amountCents: overdue ? args.arrearsDue : args.paymentAmount + args.charges,
      dueDate: args.dueDate,
      daysOverdue: overdue ? -trigger.daysUntilDue : undefined,
      lender: args.lender,
      channels,
      occurrence: `${trigger.noteType}:${localDayKey(args.today)}`,
      category: "collections",
    })
    if (sent.reached) {
      result.sent++
      await recordEntityReminder(args.tenantId, loan, trigger.noteType, sent)
    }
    // A database that is down is not a leg that failed: the tenant is retried (the legs that went out are recorded above).
    if (sent.fault) throw sent.fault
    if (sent.failed) result.errors++
    result.details.push(`Entity ${trigger.noteType} for ${loan.reference}: ${sent.summary}`)
  }
  if (overdue) await fireOverdueNotice({ tenantId: args.tenantId, loan, trigger, arrearsDue: args.arrearsDue, report: result })
}

function emptyResult(): ReminderResult {
  return { sent: 0, simulated: 0, reconciliationRequired: 0, smsChannelOff: 0, whatsappChannelOff: 0, errors: 0, details: [], tenants: 0, failedTenants: 0, warnings: 0, retryScheduled: 0, deferred: 0 }
}

export async function processPaymentReminders(): Promise<ReminderResult> {
  // The reminders cron runs without a request (cron-secret auth on
  // app/api/cron/reminders/route.ts, or the in-process scheduler), so it opens
  // each ACTIVE tenant's own frame (lib/ops/tenant-sweep.ts). Without a
  // frame the per-tenant-scoped Prisma extension cannot inject tenantId into the
  // queries sendMessage() makes on its own (Message updates without a
  // where:tenantId): it would throw TenantScopeError on every successful
  // dispatch, leaving rows stuck in QUEUED and ops unable to tell delivered
  // from undelivered.
  const total: ReminderResult = emptyResult()
  // No borrower is messaged outside the dunning window, whoever calls this (the
  // scheduler fires inside it; a manual call with the cron secret at night would
  // not). Refused before any tenant is touched: a 200 with `skipped`, no failed
  // tenant, so a scheduler claim is not marked FAILED by it.
  if (outsideDunningSendWindow(new Date())) {
    total.skipped = "outside send window"
    total.details.push(`Skipped: outside the ${DUNNING_SEND_WINDOW_LABEL} dunning send window; nothing was sent`)
    return total
  }
  const outcomes = await sweepActiveTenants("reminders", (tenant) => processTenantReminders(tenant))
  total.tenants = outcomes.length
  if (outcomes.length === 0) total.details.push("No active tenant found")
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.errors++
      total.failedTenants++
      total.details.push(tenantFailureDetail(outcome.tenant))
      continue
    }
    const r = outcome.value
    total.sent += r.sent
    total.simulated += r.simulated
    total.reconciliationRequired += r.reconciliationRequired
    total.smsChannelOff += r.smsChannelOff
    total.whatsappChannelOff += r.whatsappChannelOff
    total.errors += r.errors
    total.warnings += r.warnings
    total.retryScheduled += r.retryScheduled
    total.deferred += r.deferred
    total.details.push(...r.details)
  }
  return total
}

async function processTenantReminders(tenant: SweepTenant): Promise<ReminderResult> {
  await ensureDpdCurrent(tenant.id)
  await ensureDunningTemplates(tenant, "reminders")
  const result: ReminderResult = emptyResult()

  // Counted per trigger and reported ONCE at the end of the run, not as a
  // detail line per loan. An SMS-only trigger writes no LoanNote (there was no
  // contact to record), so alreadyProcessedToday() cannot suppress it on the
  // next tick — a per-loan line would therefore reprint for every matching
  // loan on every run for as long as SMS stays off. The aggregate stays
  // visible without growing the log without bound.
  const smsOffByTrigger = new Map<string, number>()
  // Same for a WhatsApp leg skipped because WhatsApp is off.
  const waOffByTrigger = new Map<string, number>()
  const countWaOff = (noteType: string) => {
    result.whatsappChannelOff++
    waOffByTrigger.set(noteType, (waOffByTrigger.get(noteType) ?? 0) + 1)
  }

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

  // Hoist template lookups once per run, for the channels that are ON only: a
  // channel that is off (SMS by policy, WhatsApp by WA_ENABLED or the tenant's
  // switch) is skipped per leg below and needs no template. A missing or unusable
  // template of an ENABLED channel skips that leg for the whole tenant: one
  // warning, logged and counted, never an abort and never a per-loan error.
  // active=true: a disabled template is a signal it's under revision; never
  // dispatch against it. statutoryOverride is asserted false post-lookup —
  // collections reminders are SERVICE category and must run through the
  // consent + block-status gate.
  const warn = (detail: string) => {
    result.warnings++
    result.details.push(`Warning: ${detail}`)
    console.warn(`[reminders] tenant ${tenant.id}: ${detail}`)
  }
  // One WhatsApp row per trigger, keyed by noteType. A trigger without a usable
  // row has no entry: only its WhatsApp leg is skipped, never the cron or the SMS leg.
  const templatesWa: Record<string, MessageTemplate> = {}
  const waRefusal = await whatsappRefusalForTenant(tenant.id)
  // Not knowing whether WhatsApp is on is not "WhatsApp is off": skipping every
  // WhatsApp leg as off would close the tenant's run DONE with the day's WhatsApp
  // reminders lost. The tenant fails instead, and the scheduler retries it.
  if (waRefusal === WA_SETTINGS_UNAVAILABLE_REASON) {
    throw new Error("the WhatsApp settings could not be read; the tenant is retried rather than its WhatsApp reminders dropped")
  }
  let templateSms: MessageTemplate | null = null
  if (isSmsChannelEnabled()) {
    const row = await prisma.messageTemplate.findFirst({
      where: { tenantId: tenant.id, key: "payment_reminder_sms", channel: "SMS", active: true },
    })
    if (!row) {
      warn("sms legs skipped: payment_reminder_sms template missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)")
    } else if (row.statutoryOverride !== false) {
      warn("sms legs skipped: payment_reminder_sms has statutoryOverride=true — collections reminders are SERVICE category and must NOT bypass eligibility")
    } else {
      templateSms = row
    }
  }
  for (const trigger of waRefusal ? [] : TRIGGERS) {
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
      warn(`whatsapp ${trigger.noteType} legs skipped: template ${key} missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)`)
    } else if (tpl.statutoryOverride !== false) {
      warn(`whatsapp ${trigger.noteType} legs skipped: template ${key} has statutoryOverride=true — collections reminders must NOT bypass eligibility`)
    } else {
      templatesWa[trigger.noteType] = tpl
    }
  }

  // The email leg (a consumer's payment_reminder_email, an entity's
  // entity_reminder_email) needs its template and the tenant's email provider.
  // A leg whose template is unusable, or a tenant with no active email
  // provider, has that leg skipped for the whole run: logged once and counted as a
  // tenant-level warning (the other legs are unaffected), never an error per loan,
  // and never sent without a usable template. The consumer and the entity leg are
  // judged on their own template: one unusable row does not switch the other off.
  const [templateEmail, templateEntityEmail] = await Promise.all(
    EMAIL_LEG_TEMPLATE_KEYS.map((key) => prisma.messageTemplate.findFirst({ where: { tenantId: tenant.id, key, channel: "EMAIL", active: true } })),
  )
  const emailConfig = await prisma.emailConfig.findUnique({ where: { tenantId: tenant.id }, select: { active: true } })
  const emailProviderReason = emailConfig?.active ? null : "the tenant has no active email provider"
  const emailTemplateReason = (template: MessageTemplate | null, key: string): string | null =>
    !template
      ? `template ${key} is missing or inactive`
      : template.statutoryOverride !== false
        ? `template ${key} has statutoryOverride=true, and collections reminders must not bypass consent`
        : null
  const consumerEmailSkipReason = emailProviderReason ?? emailTemplateReason(templateEmail, EMAIL_LEG_TEMPLATE_KEYS[0])
  const entityEmailSkipReason = emailProviderReason ?? emailTemplateReason(templateEntityEmail, EMAIL_LEG_TEMPLATE_KEYS[1])
  const skipped: Array<[string, string]> = emailProviderReason
    ? [["", emailProviderReason]]
    : [[" (consumer loans)", consumerEmailSkipReason], [" (entity loans)", entityEmailSkipReason]].filter((e): e is [string, string] => e[1] !== null)
  for (const [which, reason] of skipped) {
    result.warnings++
    result.details.push(`Warning: email reminder leg skipped for tenant ${tenant.name}${which}: ${reason}`)
    console.warn(`[reminders] tenant ${tenant.id}: email reminder leg skipped${which}: ${reason}`)
  }

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

  const remindLoan = async (loan: (typeof loans)[number]): Promise<void> => {
    const today = new Date()
    const dueDate = loan.nextPaymentDate!
    const daysUntil = sastDaysBetween(today, dueDate)

    // What is left of the next unpaid instalment (lib/collections/amount-owed.ts, shared with the retry sweep).
    const paymentAmount = await nextInstalmentOwed(prisma, { tenantId: tenant.id, loanId: loan.id })

    for (const trigger of TRIGGERS) {
      if (daysUntil !== trigger.daysUntilDue) continue

      const overdue = trigger.daysUntilDue < 0
      // An overdue trigger already reminded today still goes on to its
      // loan_overdue notice (below): one that failed earlier gave its reservation
      // back and is retried; one that went out is skipped by that reservation.
      const processed = await alreadyProcessedToday(loan.id, trigger.noteType, tenant.id)
      if (processed) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType} already processed today`)
        if (!overdue) continue
      }

      // The loans were selected at the start of the run, which can be long: a
      // debt-review notice, a death, an arrangement, or the loan leaving ACTIVE
      // (defaulted, settled, written off) since then must stop this send. Checked
      // per send, immediately before it (remindableLoanWhere, status included).
      if (!(await isLoanRemindable({ tenantId: tenant.id, loanId: loan.id }))) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType}, the loan stopped being ACTIVE or the loan or client was put on a dunning hold during this run`)
        continue
      }

      // What the borrower must pay now includes default charges outstanding
      // (0 while the tenant's flag is off, so the copy is unchanged).
      const charges = await chargesOutstandingAt(prisma, { tenantId: tenant.id, loanId: loan.id }, today)
      const arrearsDue = loan.arrearsAmount + charges

      // Never tell a borrower they owe R 0.00: nothing unpaid on the schedule,
      // or an overdue trigger on a loan with no arrears, is no reminder at all.
      if (nothingOwed({ paymentAmount, charges, arrearsAmount: loan.arrearsAmount, overdue: trigger.daysUntilDue < 0 })) {
        result.details.push(`Skip ${loan.reference}: ${trigger.noteType}, nothing owed`)
        continue
      }

      if (processed) {
        if (loan.client || loan.entityId) {
          await fireOverdueNotice({
            tenantId: tenant.id,
            loan: { id: loan.id, reference: loan.reference },
            ...(loan.client ? { clientId: loan.client.id } : {}),
            trigger, arrearsDue, report: result,
          })
        }
        continue
      }

      // An entity borrower (asset finance) has no Client to message: the
      // trigger's WhatsApp leg goes to the people who act for it instead, in
      // copy that names the entity (lib/asset-finance/entity-reminders.ts). Its
      // regime is not the reason; NON_NCA loans are reminded like any other.
      if (!loan.client) {
        if (!loan.entityId || !loan.entity) continue
        const skipWhatsApp = waRefusal !== null && trigger.channels.includes("whatsapp")
        if (skipWhatsApp) countWaOff(trigger.noteType)
        await remindEntityTrigger({
          tenantId: tenant.id,
          loan: { id: loan.id, reference: loan.reference, entityId: loan.entityId, entityName: loan.entity.legalName },
          trigger, dueDate, today, paymentAmount, charges, arrearsDue,
          lender: { tradingName: lenderName, collectionsPhone: companyPhone },
          emailLeg: entityEmailSkipReason === null,
          skipWhatsApp,
          result,
        })
        continue
      }

      const ctx: MessageContext = {
        firstName: loan.client.firstName,
        amount: formatZAR(paymentAmount + charges),
        date: formatDate(dueDate),
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
      const channelsRetryScheduled: string[] = []
      const channelsSuppressed: string[] = []
      const channelsFailed: string[] = []
      const sentText: Record<string, string> = {}
      // Per (loan, trigger) reach accounting, read after the channel loop.
      // `dispatched` flips the moment any leg actually reaches a provider
      // call, so "no leg was dispatched" is observed, not inferred from the
      // skip reasons. It says nothing about the OUTCOME of that call.
      let dispatched = false

      for (const channel of trigger.channels) {
        // SMS channel off. Skipped BEFORE any dispatch so no Message
        // row is written and no LoanNote can name a channel that carried
        // nothing. Not an error — the channel is off by configuration, which
        // is a policy outcome like a consent block, not a fault. The
        // WhatsApp leg of the same trigger is untouched.
        if (channel === "sms" && !isSmsChannelEnabled()) {
          result.smsChannelOff++
          smsOffByTrigger.set(trigger.noteType, (smsOffByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        // WhatsApp off (WA_ENABLED or the tenant's switch): skipped the same
        // way, before sendMessage, so no Message row is written and nothing is
        // counted as an error. The transport kill switches stay as the backstop.
        if (channel === "whatsapp" && waRefusal !== null) {
          countWaOff(trigger.noteType)
          continue
        }

        // WhatsApp policy: opportunistic. If the client doesn't have a
        // dedicated whatsapp number on file we DON'T fall back to their SMS
        // number — most clients with `whatsapp=null` simply aren't on
        // WhatsApp, and WhatsApping a number that is not on WhatsApp is a
        // delivery failure at best. A fallback would also generate "no
        // Contact row" errors for every loan with only a phone.
        //
        // Counted, not logged per loan: the skip writes no LoanNote, so
        // alreadyProcessedToday() cannot suppress it next tick and a per-loan
        // line would reprint for every matching loan on every run. One
        // aggregate at the end of the run, like the SMS-off accounting.
        if (channel === "whatsapp" && !loan.client.whatsapp) {
          noWaNumberByTrigger.set(trigger.noteType, (noWaNumberByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        if (channel === "email" && consumerEmailSkipReason) continue
        if (channel === "email" && !loan.client.email) {
          noEmailByTrigger.set(trigger.noteType, (noEmailByTrigger.get(trigger.noteType) ?? 0) + 1)
          continue
        }

        // Route through sendMessage(): channel-keyed Contact lookup, eligibility
        // check (consent + block-status), Message row + Conversation thread +
        // audit trail. No usable template for this ENABLED channel: already warned
        // once for the tenant at the top of the run, so the leg is skipped here, quietly.
        if (channel === "sms" && !templateSms) continue
        if (channel === "whatsapp" && !templatesWa[trigger.noteType]) continue
        const rawPhone = channel === "whatsapp" ? loan.client.whatsapp! : channel === "email" ? loan.client.email! : loan.client.phone
        // The report carries the loan reference and the problem, never the number or
        // address: this body is returned over HTTP and held in logs.
        const addressKind = channel === "email" ? "email address" : "phone number"
        if (!rawPhone) {
          result.errors++
          result.details.push(`Error ${loan.reference} ${channel}: no ${addressKind} on file`)
          continue
        }
        const channelEnum = channel === "whatsapp" ? "WHATSAPP" : channel === "email" ? "EMAIL" : "SMS"
        const value = channel === "whatsapp" ? toWaJid(rawPhone) : channel === "email" ? normaliseEmail(rawPhone) : normalisePhone(rawPhone)
        if (!value) {
          result.errors++
          result.details.push(`Error ${loan.reference} ${channel}: unparseable ${addressKind}`)
          continue
        }
        // The borrower's OWN Contact (lib/contact/recipient.ts): a number or address
        // that resolves to someone else's (a lead, another client) is refused, or
        // their consent would be checked and they would read this loan.
        const recipient = await lookupRecipientContact(prisma, {
          tenantId: tenant.id,
          channel: channelEnum,
          value,
          ownerClientId: loan.client.id,
        })
        if (!recipient.ok) {
          // No Contact: data drift; surface the gap, don't silently drop. Another
          // person's: refused. Either way the report names no number or address.
          result.errors++
          result.details.push(recipient.reason === "NO_CONTACT"
            ? `Error ${loan.reference} ${channel}: no Contact row`
            : `Error ${loan.reference} ${channel}: the Contact for this ${addressKind} belongs to someone else; not sent`)
          continue
        }
        const contact = recipient.contact
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
          const legStartedAt = new Date()
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
          else if (deliveryOutcome === "pending") {
            // A row this call created and the provider refused for now (RETRYING)
            // is queued for the retry sweep. A row another run created is a
            // duplicate of a send already under way, including a still-QUEUED one an
            // overlapping run created a moment after this leg started.
            if (sendResult.status === "RETRYING" && sendResult.createdAt && sendResult.createdAt.getTime() >= legStartedAt.getTime()) channelsRetryScheduled.push(channel)
            else channelsPending.push(channel)
          }
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
            // A database fault is the tenant's, not this loan's: retried (the per-loan loop rethrows it).
            if (isDatabaseInfrastructureError(err)) throw err
            console.error(`[reminders] ${loan.reference} ${channel} failed:`, err)
            result.errors++
            result.details.push(`Error ${loan.reference} ${channel}: failed; see the server log`)
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
        // (the SMS-only case); per channel when they differ, since the
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
      if (channelsRetryScheduled.length > 0) {
        result.retryScheduled++
        result.details.push(
          `Retry scheduled ${trigger.noteType} for ${loan.reference} via ${channelsRetryScheduled.join("+")}: the provider refused it for now; the retry sweep sends it inside the window`,
        )
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
        await fireOverdueNotice({
          tenantId: tenant.id,
          loan: { id: loan.id, reference: loan.reference },
          clientId: loan.client.id,
          trigger, arrearsDue, report: result,
        })
      }
    }
  }

  let loansFailed = 0
  let loansTried = 0
  for (const [index, loan] of loans.entries()) {
    // The window is checked per loan, not only when the run starts: a run that began
    // at 19:59 must stop messaging at 20:00. The loans left are deferred, not errors.
    // They are NOT simply picked up tomorrow: a trigger is date-specific (7, 1 and 0
    // days before due, 1 and 3 after), so tomorrow they match the next trigger, or
    // none, and today's reminder for them is not sent.
    if (outsideDunningSendWindow(new Date())) {
      result.deferred = loans.length - index
      result.details.push(`Deferred ${result.deferred} loan(s): the ${DUNNING_SEND_WINDOW_LABEL} dunning send window closed during this run`)
      break
    }
    loansTried++
    // A throw from any query for one loan (the already-sent check, the hold recheck, the charges
    // replay, the LoanNote write, the entity send) is that loan's error, not the tenant's day.
    try {
      await remindLoan(loan)
    } catch (err) {
      // Except a fault that is the database's: that is the tenant's, and it is retried.
      if (isDatabaseInfrastructureError(err)) throw err
      console.error(`[reminders] ${loan.reference} failed:`, err)
      result.errors++
      loansFailed++
      result.details.push(`Error ${loan.reference}: failed; see the server log`)
    }
  }
  // Every loan failing is not a run of bad luck with loans: the tenant is broken, and the retry is for it.
  if (loansTried > 0 && loansFailed === loansTried) {
    throw new Error(`every one of the ${loansTried} loan(s) tried failed; see the errors logged above`)
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

  if (result.whatsappChannelOff > 0) {
    result.details.push(
      `Skipped ${result.whatsappChannelOff} whatsapp leg(s) this run: ${waRefusal} (${tally(waOffByTrigger)}).`,
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
