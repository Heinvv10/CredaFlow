/**
 * Notifications Hub — central event-driven notification system
 * Sends email + SMS in parallel, logs every attempt to NotificationLog
 */

import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { sendSms } from "@/lib/integrations/bulksms"
import { WA_TEMPLATES, isWaEnabled } from "@/lib/whatsapp"
import { waTemplateVarsFor } from "@/lib/whatsapp/template-vars"
import { sendWhatsAppForTenant } from "@/lib/whatsapp/send-for-tenant"
import { getLenderIdentity, type LenderIdentity } from "@/lib/config/identity"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"
import { escapeHtml } from "@/lib/utils"
import { portalContinueUrl } from "@/lib/portal-urls"
import {
  applicationSubmittedEmail,
  applicationApprovedEmail,
  applicationDeclinedEmail,
  paymentReceivedEmail,
} from "@/lib/email/templates/portal"
import {
  isAppSubmittedNewSendEnabled,
  isAppDeclinedNewSendEnabled,
  isLoanApprovedNewSendEnabled,
  isLoanDisbursedNewSendEnabled,
  isLoanOverdueNewSendEnabled,
  isPaymentReceivedNewSendEnabled,
} from "@/lib/messaging/flags"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import {
  notificationLogStatusFromMessage,
  notificationLogStatusFromProviderResult,
} from "@/lib/notifications/status"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import { lookupContactByChannelValue, normaliseEmail, normalisePhone, toWaJid } from "@/lib/contact/identity"
import type { Channel, MessageTemplate } from "@prisma/client"

export type NotificationEvent =
  | "application_submitted"
  | "application_declined"
  | "loan_approved"
  | "loan_disbursed"
  | "loan_overdue"
  | "payment_received"
  | "section129_sent"

export interface NotificationOptions {
  tenantId: string
  event: NotificationEvent
  /** LoanApplication.id for application events; Loan.id for loan/payment events */
  loanId?: string
  clientId?: string
  data?: Record<string, unknown>
  /**
   * Drop the WhatsApp leg of this event, recording the skip as a `blocked`
   * NotificationLog row carrying this reason. Every other channel is
   * unaffected.
   *
   * Exists for ONE caller: the collections cron fires `loan_overdue` at
   * offsets its own reminder stages already cover, and both render on
   * WhatsApp — two dunning WhatsApps the same morning
   * (lib/collections/reminders.ts). Only the leg is dropped, never the event:
   * `loan_overdue` also carries the "Payment Overdue Notice" EMAIL, which no
   * reminder stage sends, so suppressing the event would silently take that
   * email away from the borrower.
   *
   * A skip, not a fault — `blocked`, the same status a consent suppression
   * and the SMS-channel-off skip get.
   */
  suppressWhatsAppReason?: string
}

function sastDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
}

export function notificationMessageIdempotencyKey(
  opts: NotificationOptions,
  channel: Channel,
  now = new Date(),
): string | undefined {
  const subjectId = opts.loanId ?? opts.clientId
  if (!subjectId) return undefined

  let occurrence = subjectId
  if (opts.event === "payment_received") {
    const paymentId = opts.data?.paymentId
    // Two equal payments on one loan are distinct legal receipts. Refuse to
    // collapse them when the caller has not supplied the durable Payment.id.
    if (typeof paymentId !== "string" || paymentId.trim() === "") return undefined
    occurrence = paymentId.trim()
  } else if (opts.event === "loan_overdue") {
    // Dunning may repeat on a later day, but a restarted cron must not send
    // the same channel twice for the same account/day.
    occurrence = sastDayKey(now)
  }

  return `notification:${opts.event}:${subjectId}:${occurrence}:${channel}`
}

interface ClientInfo {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  whatsapp: string | null
}

interface TemplateResult {
  subject: string
  html: string
  text: string
  waVars: WaVars
}

// Values buildWaMessage() interpolates into WA_TEMPLATES. Sourced from the
// SAME DB-fetched entities buildTemplate() already queries for email/SMS —
// NOT from opts.data, which most triggerNotification() call sites never
// populate (was the root cause of empty *${var}* gaps in sent WhatsApp
// messages, e.g. "Outstanding balance: **"). Only fields WA_TEMPLATES
// (lib/whatsapp.ts) actually interpolate belong here — no WA_TEMPLATES
// function takes a product name or decline reason.
interface WaVars {
  reference: string
  amount: number
  outstanding: number
  dueDate: string
  days: number
}

const EMPTY_WA_VARS: WaVars = {
  reference: "",
  amount: 0,
  outstanding: 0,
  dueDate: "",
  days: 0,
}

// ── Inline HTML builders for events without dedicated portal templates ─────────

function disbursedHtml(identity: LenderIdentity, name: string, ref: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table style="max-width:600px;width:100%;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
<p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
<p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Loan Disbursement</p></td></tr>
<tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold;">Your loan has been disbursed</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${name}</strong>,</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Your loan (<strong>${ref}</strong>) has been disbursed. Funds will reflect in your account within 1&ndash;2 business days. Please refer to your repayment schedule for payment dates.</p>
<p style="margin:0;color:#888;font-size:12px;">Questions? <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;">${escapeHtml(identity.publicEmail)}</a></p>
</td></tr>
<tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
<p style="margin:0;color:#888;font-size:11px;">NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)}</p></td></tr>
</table></td></tr></table></body></html>`
}

function overdueHtml(identity: LenderIdentity, name: string, days: number, ref: string): string {
  const daysText = days ? ` by <strong>${days} days</strong>` : ""
  // Quote the loan reference so a client paying by EFT/deposit puts it on the
  // payment and the bank-sync reconciler makes an EXACT match.
  const refLine = ref
    ? `<p style="margin:0 0 16px;color:#444;line-height:1.6;">Please quote your loan reference <strong>${ref}</strong> on your payment so we can allocate it to your account.</p>`
    : ""
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table style="max-width:600px;width:100%;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
<p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
<p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Payment Overdue</p></td></tr>
<tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold;">Payment overdue notice</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${name}</strong>,</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Your loan payment is overdue${daysText}. Please make payment as soon as possible to avoid additional fees and to protect your credit record.</p>
${refLine}
<p style="margin:0;color:#888;font-size:12px;">Questions? <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;">${escapeHtml(identity.publicEmail)}</a></p>
</td></tr>
<tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
<p style="margin:0;color:#888;font-size:11px;">NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)}</p></td></tr>
</table></td></tr></table></body></html>`
}

function section129Html(identity: LenderIdentity, name: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;font-size:14px;color:#1B1D24;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
<table style="max-width:600px;width:100%;" cellpadding="0" cellspacing="0">
<tr><td style="background:#1B1D24;padding:28px 32px;border-radius:8px 8px 0 0;">
<p style="margin:0;color:#4F46E5;font-size:18px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(identity.tradingName)}</p>
<p style="margin:6px 0 0;color:#f3f4f6;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Section 129 Notice</p></td></tr>
<tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold;">Section 129 Notice</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">Dear <strong>${name}</strong>,</p>
<p style="margin:0 0 16px;color:#444;line-height:1.6;">A Section 129 notice has been issued to your registered email address as required by the National Credit Act. Please review it carefully and contact us to discuss your repayment options.</p>
<p style="margin:0;color:#888;font-size:12px;">Questions? <a href="mailto:${escapeHtml(identity.publicEmail)}" style="color:#4F46E5;">${escapeHtml(identity.publicEmail)}</a></p>
</td></tr>
<tr><td style="background:#1B1D24;padding:18px 32px;border-radius:0 0 8px 8px;text-align:center;">
<p style="margin:0;color:#888;font-size:11px;">NCR Registered Credit Provider &middot; ${escapeHtml(identity.ncrNumber)}</p></td></tr>
</table></td></tr></table></body></html>`
}

// ── Template dispatcher ───────────────────────────────────────────────────────

async function buildTemplate(
  identity: LenderIdentity,
  event: NotificationEvent,
  fullName: string,
  opts: NotificationOptions
): Promise<TemplateResult> {
  const d = opts.data ?? {}

  // Application events — loanId is LoanApplication.id
  if (
    event === "application_submitted" ||
    event === "loan_approved" ||
    event === "application_declined"
  ) {
    const app = opts.loanId
      ? await prisma.loanApplication.findUnique({
          where: { id: opts.loanId },
          include: {
            product: { select: { name: true } },
            client: { select: { email: true, portalPassword: true } },
          },
        })
      : null

    const reference = String(app?.reference ?? d.reference ?? "")
    const productName = String(app?.product?.name ?? d.productName ?? "")

    if (event === "application_submitted") {
      const amount = Number(app?.appliedAmount ?? d.amount ?? 0)
      // Click-time routing via /portal/continue (login if registered, else
      // register); no CTA if we can't resolve their email.
      const portalCtaUrl = app?.client?.email
        ? portalContinueUrl(app.client.email, reference)
        : undefined
      return {
        subject: "Your Loan Application Has Been Received",
        html: applicationSubmittedEmail(identity, fullName, reference, productName, amount, portalCtaUrl),
        text: `Dear ${fullName}, your application (${reference}) has been received. We will notify you of the outcome within 1–2 business days.`,
        waVars: { ...EMPTY_WA_VARS, reference, amount },
      }
    }

    if (event === "loan_approved") {
      const amount = Number(app?.approvedAmount ?? app?.appliedAmount ?? d.amount ?? 0)
      const portalUrl = `${requireAppBaseUrl()}/portal`
      return {
        subject: "Your Loan Application Has Been Approved",
        html: applicationApprovedEmail(identity, fullName, reference, productName, amount, portalUrl),
        text: `Dear ${fullName}, your application (${reference}) has been approved. Log in to your portal to sign your credit agreement.`,
        waVars: { ...EMPTY_WA_VARS, reference, amount },
      }
    }

    // application_declined
    const reason = String(app?.decisionReason ?? d.reason ?? "")
    return {
      subject: "Update on Your Loan Application",
      html: applicationDeclinedEmail(identity, fullName, reference, reason),
      text: `Dear ${fullName}, we regret that your application (${reference}) was unsuccessful. ${reason}`,
      waVars: { ...EMPTY_WA_VARS, reference },
    }
  }

  // Loan / payment events — loanId is Loan.id
  if (
    event === "loan_disbursed" ||
    event === "loan_overdue" ||
    event === "payment_received"
  ) {
    const loan = opts.loanId
      ? await prisma.loan.findUnique({
          where: { id: opts.loanId },
          select: { reference: true, outstandingPrincipal: true },
        })
      : null

    const reference = String(loan?.reference ?? d.reference ?? "")
    const outstanding = Number(loan?.outstandingPrincipal ?? d.outstanding ?? 0)

    if (event === "payment_received") {
      const amount = Number(d.amount ?? 0)
      return {
        subject: "Payment Received — Thank You",
        html: paymentReceivedEmail(identity, fullName, amount, reference, outstanding),
        text: `Dear ${fullName}, we received your payment. Your outstanding balance is R${(outstanding / 100).toFixed(2)}.`,
        waVars: { ...EMPTY_WA_VARS, reference, amount, outstanding },
      }
    }

    if (event === "loan_disbursed") {
      // amount/dueDate aren't fetched here (this branch's DB select only
      // covers reference/outstandingPrincipal) — they come from opts.data.
      // disburse/route.ts passes the actual disbursement amount (principal
      // minus initiation fee in UPFRONT mode) and first repayment date,
      // values it already computes for the amortisation schedule.
      return {
        subject: "Loan Disbursement Confirmation",
        html: disbursedHtml(identity, fullName, reference),
        text: `Dear ${fullName}, your loan (${reference}) has been disbursed. Funds will reflect within 1–2 business days.`,
        waVars: { ...EMPTY_WA_VARS, reference, amount: Number(d.amount ?? 0), dueDate: String(d.dueDate ?? "") },
      }
    }

    // loan_overdue
    const days = Number(d.daysOverdue ?? 0)
    return {
      subject: "Payment Overdue Notice",
      html: overdueHtml(identity, fullName, days, reference),
      text: `Dear ${fullName}, your loan payment is overdue${days ? ` by ${days} days` : ""}. Please make payment immediately${reference ? `, quoting reference ${reference}` : ""}.`,
      // "amount overdue" isn't computed by this branch — it comes from
      // opts.data.amount, which both callers set to Loan.arrearsAmount (CENTS;
      // lib/collections/reminders.ts and escalation.ts).
      // `outstanding` isn't included here: payment_overdue_1d/7d don't
      // interpolate it (only payment_received does).
      waVars: { ...EMPTY_WA_VARS, reference, amount: Number(d.amount ?? 0), days },
    }
  }

  // section129_sent
  return {
    subject: "Section 129 Notice Sent",
    html: section129Html(identity, fullName),
    text: `Dear ${fullName}, a Section 129 notice has been sent to your registered email. Please review it carefully.`,
    waVars: { ...EMPTY_WA_VARS, reference: String(d.reference ?? "") },
  }
}

// ── Client resolver ───────────────────────────────────────────────────────────

// WA_TEMPLATES want a compact "R1 000" (no decimals, space-grouped, no
// space after "R") — deliberately NOT converged with lib/utils.formatZAR
// ("R 1,000.00": space after R, 2 decimals, comma-grouped). Different
// output format, and formatZAR must not be touched (SMS GSM-7 + NCA s129 —
// see lib/pdf/.claude.md). This preserves the WA_TEMPLATES formatting that
// was already live before this fix (e.g. application_submitted).
function formatRand(cents: number): string {
  return `R${(cents / 100).toLocaleString("en-ZA", { maximumFractionDigits: 0 })}`
}

interface WaBuildResult {
  message: string | null
  // Field names still missing when message is null — empty when a message
  // was built, or when the event has no WA leg (default case below).
  missingVars: string[]
  /** Discrete named vars for the WABA template body. Supplied ALONGSIDE the
   *  pre-rendered `body`, not instead of it: `body` renders the free-text
   *  in-window send, these fill `bodyTemplate` for the out-of-window template
   *  send. See lib/whatsapp/template-vars.ts for why both are needed. */
  templateVars: Record<string, string>
}

// Logs + skips instead of sending a WhatsApp message with an empty
// *${var}* gap (the root cause of the empty-balance / empty-ref bug this
// function fixes) — a missing var is a data-plumbing bug, not a reason to
// silently corrupt what lands in /inbox. The caller (triggerNotification)
// turns missingVars into a "failed" NotificationLog row so this is visible
// on ops dashboards, not just in logs.
function skipMissingVars(event: NotificationEvent, fields: Record<string, string>): WaBuildResult {
  const missingVars = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k)
  console.error(
    `[buildWaMessage] event=${event} missing template var(s): ${missingVars.join(", ")} — skipping WhatsApp send`
  )
  return { message: null, missingVars, templateVars: {} }
}

function ok(message: string, templateVars: Record<string, string> = {}): WaBuildResult {
  return { message, missingVars: [], templateVars }
}

/**
 * The WABA template event an event's WhatsApp leg sends. Identity for every
 * event but `loan_overdue`, whose free text branches 1-day notice vs 7-day
 * "URGENT" escalation on days overdue — a Meta template is ONE fixed body, so
 * each branch has its own row. The threshold is the one buildWaMessage uses.
 */
function waTemplateEventFor(event: NotificationEvent, days: number): string {
  if (event !== "loan_overdue") return event
  return days >= 7 ? "loan_overdue_7d" : "loan_overdue_1d"
}

function buildWaMessage(identity: LenderIdentity, event: NotificationEvent, firstName: string, vars: WaVars): WaBuildResult {
  const ref = vars.reference
  const amount = vars.amount ? formatRand(vars.amount) : ""
  const balance = vars.outstanding ? formatRand(vars.outstanding) : ""
  const dueDate = vars.dueDate
  const phone = identity.collectionsPhone
  // Derived from the same locals the free-text wording interpolates, so a
  // template send and an in-window send can never quote different figures.
  const tv = waTemplateVarsFor(waTemplateEventFor(event, vars.days), {
    firstName,
    reference: ref,
    amount,
    outstanding: balance,
    dueDate,
    supportPhone: phone,
    daysOverdue: vars.days ? String(vars.days) : "",
  })

  switch (event) {
    case "application_submitted": {
      const fields = { reference: ref, amount }
      if (!ref || !amount) return skipMissingVars(event, fields)
      return ok(WA_TEMPLATES.application_submitted(firstName, ref, amount, identity.tradingName), tv)
    }
    case "loan_approved": {
      const fields = { amount, reference: ref }
      if (!amount || !ref) return skipMissingVars(event, fields)
      return ok(WA_TEMPLATES.application_approved(firstName, amount, ref), tv)
    }
    case "application_declined": {
      if (!ref) return skipMissingVars(event, { reference: ref })
      return ok(WA_TEMPLATES.application_declined(firstName, ref), tv)
    }
    case "loan_disbursed": {
      const fields = { amount, dueDate }
      if (!amount || !dueDate) return skipMissingVars(event, fields)
      return ok(WA_TEMPLATES.loan_disbursed(firstName, amount, dueDate), tv)
    }
    case "payment_received": {
      const fields = { amount, outstanding: balance }
      if (!amount || !balance) return skipMissingVars(event, fields)
      return ok(WA_TEMPLATES.payment_received(firstName, amount, balance), tv)
    }
    case "loan_overdue": {
      // "amount overdue" comes from opts.data.amount (see buildTemplate).
      // A caller that omits it skips here (logged + NotificationLog'd)
      // rather than sending an empty *amount*.
      const fields = { amount, reference: ref }
      if (!amount || !ref) return skipMissingVars(event, fields)
      if (waTemplateEventFor(event, vars.days) === "loan_overdue_7d") return ok(WA_TEMPLATES.payment_overdue_7d(firstName, amount, ref, phone), tv)
      return ok(WA_TEMPLATES.payment_overdue_1d(firstName, amount, ref), tv)
    }
    case "section129_sent": {
      if (!ref) return skipMissingVars(event, { reference: ref })
      return ok(WA_TEMPLATES.section129(firstName, ref, phone), tv)
    }
    default:
      return { message: null, missingVars: [], templateVars: {} }
  }
}

async function resolveClient(opts: NotificationOptions): Promise<ClientInfo | null> {
  try {
    if (opts.clientId) {
      return await prisma.client.findUnique({
        where: { id: opts.clientId },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, whatsapp: true },
      })
    }
    if (opts.loanId) {
      // loanId may be a Loan.id or LoanApplication.id depending on the event
      const loan = await prisma.loan.findUnique({
        where: { id: opts.loanId },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, whatsapp: true } },
        },
      })
      if (loan?.client) return loan.client

      const app = await prisma.loanApplication.findUnique({
        where: { id: opts.loanId },
        include: {
          client: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, whatsapp: true } },
        },
      })
      return app?.client ?? null
    }
    return null
  } catch {
    return null
  }
}

export function sanitizeNotificationLogError(error?: string) {
  return error?.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "?")
}

async function logNotification(
  tenantId: string,
  opts: {
    loanId?: string
    clientId?: string
    event: string
    channel: string
    status: string
    error?: string
    messageId?: string
  }
): Promise<void> {
  const safeError = sanitizeNotificationLogError(opts.error)
  try {
    await prisma.notificationLog.create({
      data: {
        tenantId,
        loanId: opts.loanId,
        clientId: opts.clientId,
        event: opts.event,
        channel: opts.channel,
        status: opts.status,
        error: safeError,
        ...(opts.messageId ? { messageId: opts.messageId } : {}),
      },
    })
  } catch (e) {
    console.error("Failed to log notification:", e)
  }
}

// ── Shared new-send dispatch (flag-gated, used by every cutover event) ────────
//
// New-send path: render the legacy template, look up Contact rows per
// channel via ContactIdentity, dispatch through sendMessage(). NotificationLog
// rows are still written so the staff + portal notifications pages keep
// working — NotificationLog stays until every event has cut over.
//
// Behaviour preserved across all events:
//   - Email + SMS always attempted (canonical channels).
//   - WhatsApp attempted only when client.whatsapp is set — mirrors the
//     payment-reminder policy (lib/collections/reminders.ts).
//     A missing whatsapp number is "silent skip" (don't fail the notif).
//   - SendBlockedError (consent / channel opt-out / BLOCKED contact) is
//     recorded as a "blocked" NotificationLog row — NOT as an error — so
//     ops dashboards don't false-alarm on a legitimately suppressed send.

async function sendEventNewSend(
  opts: NotificationOptions,
  client: ClientInfo,
  template: TemplateResult,
  waMessage: string | null,
  waTemplateVars: Record<string, string>,
  waTemplateEvent: string,
): Promise<void> {
  const keyEmail = `${opts.event}_email`
  const keySms = `${opts.event}_sms`
  // Not always `${opts.event}_whatsapp`: loan_overdue sends one of two rows.
  const keyWhatsapp = `${waTemplateEvent}_whatsapp`

  const t = await prisma.tenant.findUnique({
    where: { id: opts.tenantId },
    select: { id: true },
  })
  if (!t) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "all",
      status: "failed",
      error: "Tenant not found",
    })
    return
  }

  const templates = await prisma.messageTemplate.findMany({
    where: {
      tenantId: opts.tenantId,
      key: { in: [keyEmail, keySms, keyWhatsapp] },
      active: true,
    },
  })
  const byKey: Record<string, MessageTemplate> = {}
  for (const tpl of templates) {
    // `key` is `String?` in schema until step 1c lands. We filtered on
    // `key: { in: [...] }` so SQL excludes NULL; skip defensively so a
    // future schema change can't sneak a null-keyed row in via `byKey[""]`.
    if (!tpl.key) continue
    byKey[tpl.key] = tpl
  }

  // Missing-template guard. We deliberately do NOT silently fall back to the
  // legacy path — that would mask a deployment mistake (operator flipped the
  // flag without seeding the tenant's default templates).
  // Fail loud per channel.
  //
  // One exception: loan_overdue's per-branch WhatsApp rows
  // (loan_overdue_1d/7d_whatsapp). An unusable one
  // fails ONLY the WhatsApp leg — email and SMS still send — so a missing
  // WhatsApp row cannot take the overdue notice down on every channel. Every other key keeps the whole-event abort.
  const waVariantRow = waTemplateEvent !== opts.event
  let waProblem: string | null = null
  const required = [
    { key: keyEmail, channel: "EMAIL" as Channel },
    { key: keySms, channel: "SMS" as Channel },
    { key: keyWhatsapp, channel: "WHATSAPP" as Channel },
  ]
  for (const { key, channel } of required) {
    const tpl = byKey[key]
    const problem = !tpl
      ? `Template ${key} missing — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)`
      : tpl.statutoryOverride !== false
        ? `Template ${key} has statutoryOverride=true — refused (notif templates must not bypass eligibility)`
        : null
    if (!problem) continue
    if (waVariantRow && channel === "WHATSAPP") {
      waProblem = problem
      continue
    }
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: channel.toLowerCase(),
      status: "failed",
      error: problem,
    })
    return
  }

  // Per-channel dispatch. We collect promises but resolve them serially-ish:
  // sendMessage opens its own transaction so concurrent calls compete for
  // the FOR UPDATE consent locks; for a single client + single trigger,
  // sequential is fine and keeps the audit ordering deterministic.
  await dispatchChannel({
    opts,
    client,
    template: byKey[keyEmail],
    channel: "EMAIL",
    value: normaliseEmail(client.email),
    vars: { subject: template.subject, text: template.text, html: template.html },
  })

  // SMS channel off (BULKSMS_DRY_RUN). Record the skip as a "blocked" row —
  // the same status a consent suppression gets, since both are policy
  // outcomes rather than faults — and dispatch nothing, so no SIMULATED
  // Message row is written. Email and WhatsApp are unaffected.
  if (!isSmsChannelEnabled()) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "sms",
      status: "blocked",
      error: SMS_CHANNEL_OFF_REASON,
    })
  } else {
    const smsValue = normalisePhone(client.phone)
    await dispatchChannel({
      opts,
      client,
      template: byKey[keySms],
      channel: "SMS",
      value: smsValue,
      vars: { body: template.text },
    })
  }

  // WhatsApp policy mirrors the payment reminders (lib/collections/reminders.ts): use
  // `client.whatsapp` for the WA leg, skip silently when null. Most clients
  // with `whatsapp=null` simply aren't on WhatsApp and falling back to
  // `client.phone` would (a) attempt delivery to a non-WA number, and
  // (b) look up a ContactIdentity that provisionContactForClient never wrote
  // (it only writes the WA identity when input.whatsapp is set).
  if (opts.suppressWhatsAppReason) {
    // Checked FIRST, ahead of the template-problem and no-number branches:
    // the caller has already decided this leg must not go out, so neither a
    // template fault nor a missing number is worth reporting about a leg
    // nobody was going to send. Recorded, never silently dropped.
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: "blocked",
      error: opts.suppressWhatsAppReason,
    })
  } else if (waMessage && client.whatsapp && waProblem) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: "failed",
      error: waProblem,
    })
  } else if (waMessage && client.whatsapp) {
    const waValue = toWaJid(client.whatsapp)
    await dispatchChannel({
      opts,
      client,
      template: byKey[keyWhatsapp],
      channel: "WHATSAPP",
      value: waValue,
      // `body` renders the free-text in-window send; the discrete vars fill
      // the WABA bodyTemplate for an out-of-window template send. Both, not
      // either — send.ts drops the template if any placeholder is unfilled.
      // For loan_overdue the row's `body` has no {{body}}: in-window free
      // text is rendered from the loan_overdue_1d/7d row body, NOT from
      // WA_TEMPLATES.payment_overdue_*. Only the legacy flag-off path still
      // sends the WA_TEMPLATES copy.
      vars: { body: waMessage, ...waTemplateVars },
    })
  } else if (waMessage) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: "blocked",
      error: "No WhatsApp on file",
    })
  }
}

async function dispatchChannel(args: {
  opts: NotificationOptions
  client: ClientInfo
  template: MessageTemplate
  channel: Channel
  value: string
  vars: Record<string, string>
}): Promise<void> {
  const channelLower = args.channel.toLowerCase()
  if (!args.value) {
    await logNotification(args.opts.tenantId, {
      loanId: args.opts.loanId,
      clientId: args.client.id,
      event: args.opts.event,
      channel: channelLower,
      status: "failed",
      error: `Unparseable ${args.channel} value`,
    })
    return
  }

  const contact = await lookupContactByChannelValue(prisma, {
    tenantId: args.opts.tenantId,
    channel: args.channel,
    value: args.value,
  })
  if (!contact) {
    // Data drift — Client without a ContactIdentity row for this channel.
    // Should never happen for clients created since the client-create flow
    // calls provisionContactForClient; surface the gap loudly for legacy
    // clients pre-backfill.
    await logNotification(args.opts.tenantId, {
      loanId: args.opts.loanId,
      clientId: args.client.id,
      event: args.opts.event,
      channel: channelLower,
      status: "failed",
      error: `No Contact row for ${args.value}`,
    })
    return
  }

  try {
    const msg = await sendMessage({
      contactId: contact.id,
      channel: args.channel,
      template: args.template,
      vars: args.vars,
      toValue: args.value,
      category: args.opts.event,
      loanId: APPLICATION_EVENTS.has(args.opts.event) ? undefined : args.opts.loanId,
      applicationId: APPLICATION_EVENTS.has(args.opts.event) ? args.opts.loanId : undefined,
      idempotencyKey: notificationMessageIdempotencyKey(args.opts, args.channel),
    })
    // A fresh send returns a durable terminal state. An idempotent replay may
    // return the existing pending or failed reservation, which must be
    // projected truthfully without attempting another provider dispatch.
    // Double-write failures throw KnownDispatchPersistenceError below so the
    // known provider-accepted versus simulated outcome remains explicit.
    const status = notificationLogStatusFromMessage(msg.status)
    await logNotification(args.opts.tenantId, {
      loanId: args.opts.loanId,
      clientId: args.client.id,
      event: args.opts.event,
      channel: channelLower,
      status,
      messageId: msg.id,
    })
  } catch (err) {
    if (err instanceof SendBlockedError) {
      // Legitimate suppression — not an error from ops' perspective.
      await logNotification(args.opts.tenantId, {
        loanId: args.opts.loanId,
        clientId: args.client.id,
        event: args.opts.event,
        channel: channelLower,
        status: "blocked",
        error: err.reason,
      })
      return
    }
    if (err instanceof KnownDispatchPersistenceError) {
      await logNotification(args.opts.tenantId, {
        loanId: args.opts.loanId,
        clientId: args.client.id,
        event: args.opts.event,
        channel: channelLower,
        status: err.outcome === "SIMULATED"
          ? "simulated_db_write_failed"
          : "provider_accepted_db_write_failed",
        error: `${err.message}; messageId=${err.messageId}; providerMessageId=${err.providerMessageId ?? "none"}; simulationReceiptId=${err.simulationReceiptId ?? "none"}; providerEvidence=${err.evidenceReference ?? "none"}`,
        messageId: err.messageId,
      })
      return
    }
    if (err instanceof MessageReconciliationRequiredError) {
      await logNotification(args.opts.tenantId, {
        loanId: args.opts.loanId,
        clientId: args.client.id,
        event: args.opts.event,
        channel: channelLower,
        status: "reconciliation_required",
        error: `Provider outcome requires reconciliation; messageId=${err.messageRecord.id}; automatic replay blocked`,
        messageId: err.messageRecord.id,
      })
      return
    }
    await logNotification(args.opts.tenantId, {
      loanId: args.opts.loanId,
      clientId: args.client.id,
      event: args.opts.event,
      channel: channelLower,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Events whose `opts.loanId` is actually a `LoanApplication.id`. The rest
// (loan_disbursed, loan_overdue, payment_received) carry a real `Loan.id`.
// dispatchChannel uses this to route correctly into Conversation's two
// separate FK columns (Conversation.applicationId vs Conversation.loanId);
// landing a Loan.id in applicationId would throw P2003 at INSERT.
const APPLICATION_EVENTS: ReadonlySet<NotificationEvent> = new Set([
  "application_submitted",
  "application_declined",
  "loan_approved",
])

// Per-event flag table. Each entry is `() => boolean` so the env var is
// read at call time (test suites rely on mutating process.env between
// describe blocks). Events absent from this map stay on the legacy path
// regardless of any env flag — section129_sent does its cutover inside
// the s.129 route, not here.
const NEW_SEND_FLAGS: Partial<Record<NotificationEvent, () => boolean>> = {
  application_submitted: isAppSubmittedNewSendEnabled,
  application_declined: isAppDeclinedNewSendEnabled,
  loan_approved: isLoanApprovedNewSendEnabled,
  loan_disbursed: isLoanDisbursedNewSendEnabled,
  loan_overdue: isLoanOverdueNewSendEnabled,
  payment_received: isPaymentReceivedNewSendEnabled,
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function triggerNotification(opts: NotificationOptions): Promise<void> {
  const client = await resolveClient(opts)
  if (!client) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: opts.clientId,
      event: opts.event,
      channel: "all",
      status: "failed",
      error: "Client not found",
    })
    return
  }

  // Fails closed: an unconfigured identity throws out of the notification
  // rather than sending a message that names no (or the wrong) lender.
  const identity = await getLenderIdentity(opts.tenantId)
  const fullName = `${client.firstName} ${client.lastName}`
  const template = await buildTemplate(identity, opts.event, fullName, opts)

  const waBuild = buildWaMessage(identity, opts.event, client.firstName, template.waVars)
  const waMessage = waBuild.message

  // A missing template var is a data-plumbing bug (see buildWaMessage), not
  // a policy-driven skip like "no WhatsApp on file" — log it as "failed" so
  // it surfaces on ops dashboards instead of only in console output. One
  // write here covers both the new-send and legacy dispatch paths below,
  // since neither writes a whatsapp NotificationLog row when waMessage is
  // null (new-send's WA branch and the legacy `if (waMessage)` guard both
  // require a truthy message).
  // A suppressed leg gets no WA_VARS_MISSING row: two whatsapp rows for one
  // event ("failed" then "blocked") reads as a fault on a leg that was never
  // going to be sent. The suppression row below is the honest single record.
  if (waBuild.missingVars.length > 0 && !opts.suppressWhatsAppReason) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: "failed",
      error: `WA_VARS_MISSING: ${waBuild.missingVars.join(", ")}`,
    })
  }

  // Flag-gated cutover. Each event in NEW_SEND_FLAGS can be
  // independently cut over via its env flag. Events absent from the map
  // (e.g. section129_sent) stay on the legacy direct-send path.
  // The new-send path writes Message + Conversation + Audit rows in addition
  // to NotificationLog (preserved so the staff + portal dashboards keep working).
  const flagFn = NEW_SEND_FLAGS[opts.event]
  if (flagFn?.()) {
    return sendEventNewSend(
      opts,
      client,
      template,
      waMessage,
      waBuild.templateVars,
      waTemplateEventFor(opts.event, template.waVars.days),
    )
  }

  // SMS channel off (BULKSMS_DRY_RUN): the leg is not dispatched at all, so
  // `sends` is one shorter and the WhatsApp result moves down an index —
  // hence the explicit offsets below rather than a fixed [0,1,2] destructure.
  //
  // NOTE this also covers `section129_sent`, the one STATUTORY event on this
  // path (it is absent from NEW_SEND_FLAGS, so it never reaches the new-send
  // branch above). The s.129 notice itself is the PDF + email dispatched by
  // app/api/loans/section129/route.ts; this SMS was a courtesy leg on top of
  // it, and with the channel off it could only ever have produced a
  // `simulated` NotificationLog row. It is recorded as `blocked` with the
  // reason named, never silently dropped.
  const smsEnabled = isSmsChannelEnabled()
  const sends: Array<{ name: "email" | "sms" | "whatsapp"; promise: Promise<unknown> }> = [
    { name: "email", promise: sendEmail({
      tenantId: opts.tenantId,
      to: client.email,
      toName: fullName,
      subject: template.subject,
      html: template.html,
      text: template.text,
      category: opts.event,
      referenceId: opts.loanId,
    }) },
  ]

  if (smsEnabled) {
    sends.push({ name: "sms", promise: sendSms({
      tenantId: opts.tenantId,
      to: client.phone,
      message: template.text,
    }) })
  }

  // Suppressed by the caller (see NotificationOptions.suppressWhatsAppReason).
  // The leg is not pushed, so `byName` has no "whatsapp" entry and the
  // outcome bookkeeping below already treats it as not attempted. The skip is
  // recorded here rather than left to that default, which would log nothing.
  if (opts.suppressWhatsAppReason) {
    await logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: "blocked",
      error: opts.suppressWhatsAppReason,
    })
  } else if (waMessage && isWaEnabled()) {
    // Mirrors the reach of the manual sendWhatsAppMessage() calls this PR
    // removed from decide/route.ts and disburse/route.ts (client.whatsapp
    // ?? client.phone) — using client.phone only would have narrowed WA
    // delivery for any client whose WhatsApp number differs from their
    // primary phone.
    // Routed through the tenant's configured provider. section129_sent always
    // reaches this branch (it is absent from NEW_SEND_FLAGS); the other six
    // reach it too wherever their env flag is unset, since each defaults false
    // — so the blast radius is up to seven borrower-facing events, not one.
    // Before this it
    // called the Baileys bridge directly — a transport with no numbers paired
    // since the WA_CLOUD cutover, so the courtesy notice silently never sent.
    sends.push({ name: "whatsapp", promise: sendWhatsAppForTenant({
      tenantId: opts.tenantId,
      to: client.whatsapp ?? client.phone,
      message: waMessage,
    }) })
  }

  // Keyed by name, never by position: the SMS leg is conditional, so a fixed
  // [0,1,2] destructure silently reported the email's outcome as WhatsApp's
  // whenever SMS was skipped. An absent key means "not attempted".
  const settled = await Promise.allSettled(sends.map((s) => s.promise))
  const byName = new Map(sends.map((s, i) => [s.name, settled[i]]))
  const emailResult = byName.get("email")!
  const waResult = byName.get("whatsapp")

  type LegacyProviderResult = {
    ok: boolean
    simulated?: boolean
    error?: string
    providerOutcome?: "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
    emailLogPersistenceError?: string
  }
  const rejectedResult: LegacyProviderResult = { ok: false, providerOutcome: "AMBIGUOUS" }
  const notAttemptedResult: LegacyProviderResult = {
    ok: false,
    providerOutcome: "DEFINITELY_REJECTED",
  }
  const emailValue = emailResult.status === "fulfilled"
    ? emailResult.value as LegacyProviderResult
    : rejectedResult
  const emailError =
    emailResult.status === "rejected"
      ? String(emailResult.reason)
      : !emailValue.ok
        ? emailValue.error
        : emailValue.emailLogPersistenceError

  const waValue = waResult?.status === "fulfilled"
    ? waResult.value as LegacyProviderResult
    : waResult?.status === "rejected"
      ? rejectedResult
      : notAttemptedResult
  const waError =
    waResult?.status === "rejected"
      ? String(waResult.reason)
      : !waValue.ok
        ? waValue.error
        : undefined

  const logs: Promise<void>[] = [
    logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "email",
      status: notificationLogStatusFromProviderResult(emailValue),
      error: emailError,
    }),
  ]

  if (smsEnabled) {
    // Computed here rather than above so nothing derives a provider outcome
    // from a leg that was never dispatched.
    const smsResult = byName.get("sms")!
    const smsValue = smsResult.status === "fulfilled"
      ? smsResult.value as LegacyProviderResult
      : rejectedResult
    const smsError =
      smsResult.status === "rejected"
        ? String(smsResult.reason)
        : !smsValue.ok
          ? smsValue.error
          : undefined
    logs.push(logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "sms",
      status: notificationLogStatusFromProviderResult(smsValue),
      error: smsError,
    }))
  } else {
    logs.push(logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "sms",
      status: "blocked",
      error: SMS_CHANNEL_OFF_REASON,
    }))
  }

  // A suppressed leg already has its `blocked` row, written where the
  // dispatch would have been pushed. Without this guard it would get a SECOND
  // row here — `notAttemptedResult` maps to "failed", so the audit trail would
  // show a WhatsApp fault for a leg deliberately not sent.
  if (waMessage && !opts.suppressWhatsAppReason) {
    logs.push(logNotification(opts.tenantId, {
      loanId: opts.loanId,
      clientId: client.id,
      event: opts.event,
      channel: "whatsapp",
      status: notificationLogStatusFromProviderResult(waValue),
      error: waError,
    }))
  }

  await Promise.allSettled(logs)
}
