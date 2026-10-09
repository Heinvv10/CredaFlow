/**
 * The WABA template bodies, and the variables each event supplies to fill them.
 *
 * Why this file exists: every WhatsApp `MessageTemplate` shipped with
 * `body = "{{body}}"` — an envelope holding one pre-rendered blob composed in
 * `WA_TEMPLATES` — and `lib/notifications.ts` supplied exactly `vars: { body }`.
 * That works for a free-text send inside Meta's 24h window and is unusable as a
 * Meta template, because Meta rejects a body that is only a parameter. Proven
 * against the live API on 2026-08-12 with a body of exactly `{{body}}`:
 *
 *   error_subcode 2388047 — "The message body can't have more than two
 *   consecutive newline characters, only have parameters, or have more than
 *   10 emojis."
 *
 * So a template needs real static text with DISCRETE named variables. And the
 * names must be exactly what the sending code supplies, and getting that wrong
 * fails in TWO different ways:
 *   - ABSENT var -> `renderTemplate` (lib/messaging/render.ts:34) THROWS,
 *     out of `sendMessage` entirely. Not a degrade: the whole send fails.
 *   - PRESENT-but-BLANK -> the graceful gate at send.ts:587 drops the template,
 *     falling back to free text in-window and WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE
 *     outside it.
 * The first is why **the code must be deployed BEFORE the migration**: a
 * non-NULL bodyTemplate with the old `vars: { body }` throws on every send.
 * `template-vars-contract.test.ts` pins the two halves together.
 *
 * The wording is carried over verbatim from `WA_TEMPLATES` in `lib/whatsapp.ts`
 * — the copy customers already receive — with the interpolations turned into
 * named variables. The collections and `loan_overdue_*` bodies are the
 * exception; their notes say what changed and why.
 */
/** Every value a WhatsApp template body may reference, already formatted. */
export type WaTemplateVarSource = {
  firstName: string
  reference: string
  amount: string
  outstanding: string
  dueDate: string
  supportPhone: string
  /** Only `loan_overdue_7d` reads this; other callers need not supply it. */
  daysOverdue?: string
}

/**
 * A SEED-TIME token, not a send-time variable. The migration that writes a
 * body carrying it replaces it, per tenant, with the literal
 * `COALESCE(TenantConfig.brandName, Tenant.name)` — the same brand the SMS
 * copy uses (`brandName ?? tenant.name` in reminders.ts). It stays static text
 * in the stored row because every extra Meta variable raises the risk of a
 * "too many variables for its length" rejection. So no sending code supplies
 * it, and the stored body never contains it.
 */
export const SEED_BRAND_TOKEN = "{{lenderName}}"

/** The body as the migration stores it for a tenant whose brand is `brand`. */
export function withSeededBrand(body: string, brand: string): string {
  return body.split(SEED_BRAND_TOKEN).join(brand)
}

/**
 * Bodies for the events that reach the template-capable sender — i.e. those in
 * `NEW_SEND_FLAGS`, which dispatch through `sendMessage()`.
 *
 * Also the collections-reminder cron (`lib/collections/reminders.ts`), whose
 * WhatsApp triggers each get their OWN row — see `payment_reminder_*` below.
 *
 * NOT here, deliberately:
 *   - `section129_sent` — takes the legacy branch (absent from NEW_SEND_FLAGS),
 *     which calls the transport directly and has no template mechanism.
 *   - `payment_reminder_whatsapp`, the shared `{{body}}` passthrough row the
 *     collections cron used for every trigger. Meta cannot register it, and it
 *     is no longer read. Left in place, not rewritten: see the migration.
 *   - `loan_overdue` itself. The free-text path picks between a 1-day notice
 *     and a 7-day "URGENT" escalation from `vars.days`, and a Meta template is
 *     ONE fixed body — so the WhatsApp leg sends `loan_overdue_1d` or
 *     `loan_overdue_7d` instead (lib/notifications.ts, waTemplateEventFor).
 */
// Keyed by NotificationEvent. Typed as a plain record rather than importing
// that union from lib/notifications.ts, which imports this module back.
//
export const WABA_BODY_TEMPLATES: Record<string, string> = {
  application_submitted:
    "Hi {{firstName}} 👋\n\nYour loan application *{{reference}}* for *{{amount}}* has been received.\n\nWe'll review it within 24 hours and be in touch. Thank you for choosing {{lenderName}}.",

  loan_approved:
    "Good news {{firstName}}! 🎉\n\nYour loan application for *{{amount}}* has been *approved*.\n\nRef: {{reference}}\n\nWe'll be in touch shortly to finalise the agreement.",

  application_declined:
    "Hi {{firstName}},\n\nUnfortunately your application *{{reference}}* was unsuccessful at this time.\n\nPlease contact us if you have any questions or would like to discuss alternative options.",

  loan_disbursed:
    "Hi {{firstName}} ✅\n\nYour loan of *{{amount}}* has been paid to your account.\n\nYour first payment is due on *{{dueDate}}*. You can view your repayment schedule on the client portal.",

  payment_received:
    "Hi {{firstName}} ✅\n\nWe've received your payment of *{{amount}}*.\n\nOutstanding balance: *{{outstanding}}*. Thank you!",

  // Wording carried over verbatim from WA_TEMPLATES.payment_due_3d. Its row is
  // a NEW key (`payment_due_3d_whatsapp`), NOT the existing
  // `payment_reminder_whatsapp` — that one is a literal `{{body}}` passthrough
  // the collections cron used to send, before each of its WhatsApp triggers
  // got its own row. No current code reads it.
  payment_due_3d:
    "Hi {{firstName}},\n\nReminder: A payment of *{{amount}}* is due on *{{dueDate}}*.\n\nPayment reference: *{{reference}}*\n\nPlease ensure funds are available. Log in to the portal to pay or view your schedule.",

  // Not a notification event — the inbox sends this. Meta forbids a body that
  // is only a parameter, so an agent can never deliver their own free text to
  // an out-of-window customer. This template exists to REOPEN the 24h window:
  // the customer replies, and free text is lawful again. It deliberately
  // promises only that someone will continue the conversation, because that is
  // the one thing we can guarantee at the moment it sends.
  agent_reengagement:
    "Hi {{firstName}},\n\nWe have an update about your enquiry with {{lenderName}}.\n\nPlease reply to this message and a consultant will continue the conversation with you here.",

  // The collections-reminder triggers, one row each (TRIGGERS in
  // lib/collections/reminders.ts). Wording is the SMS copy those triggers
  // compose, changed only where Meta requires: a body may not END on a
  // variable, so the one that ended on `${phone}` now ends on static text.
  // `{{lenderName}}` is NOT a send-time variable — see SEED_BRAND_TOKEN.
  // The 7-day notice carried "Reply STOP to opt out" — an SMS convention. It
  // is dropped here: WhatsApp opt-out is native (Block / Report), and an
  // inbound "STOP" is honoured by lib/messaging/wa-stop.ts whether or not the
  // message advertises it. The closing sentence replaces it so four variables
  // do not sit in a ~40-character body, which is the shape Meta rejects for
  // variable-to-text ratio.
  payment_reminder_7d:
    "Hi {{firstName}}, your loan payment of {{amount}} is due on {{dueDate}}. Ref: {{reference}}. Please ensure funds are available. {{lenderName}}",

  payment_reminder_1d:
    "Reminder: {{amount}} due TOMORROW ({{dueDate}}) on loan {{reference}}. Please ensure funds are available. {{lenderName}}",

  payment_reminder_0d:
    "Your loan payment of {{amount}} is due TODAY. Please pay to avoid late fees. Ref: {{reference}}. Call {{lenderName}} on {{supportPhone}} if you need help.",

  // v2 of the above, "late fees" replaced now that default interest and
  // charges exist. Its own row and Meta name, so v1 keeps sending until v2 is
  // APPROVED by Meta.
  payment_reminder_0d_v2:
    "Your loan payment of {{amount}} is due TODAY. Please pay today to avoid default interest and charges. Ref: {{reference}}. Call {{lenderName}} on {{supportPhone}} if you need help.",

  // Its trigger fires ONLY at daysUntilDue === -1, so "was due yesterday" is
  // literally true here — unlike loan_overdue_1d, which is also sent at 3 days
  // overdue and therefore had to drop the word. Wording is otherwise the SMS
  // copy verbatim, plus the trailing brand the sibling collections bodies carry.
  payment_reminder_overdue_1d:
    "URGENT: Your payment of {{amount}} on loan {{reference}} was due yesterday. Please pay immediately to avoid additional charges. {{lenderName}}",

  // `outstanding` carries the ARREARS amount here, which is what the trigger's
  // own copy labels "Outstanding".
  payment_reminder_overdue_3d:
    "IMPORTANT: Loan {{reference}} is 3 days overdue. Outstanding: {{outstanding}}. Contact us immediately: {{supportPhone}}. {{lenderName}}",

  // From WA_TEMPLATES.payment_overdue_1d. "was due yesterday" became "is
  // overdue": this body is also sent at 3 days overdue (reminders.ts
  // overdue_3d), where "yesterday" is false.
  loan_overdue_1d:
    "Hi {{firstName}},\n\n⚠️ Your payment of *{{amount}}* on loan *{{reference}}* is overdue.\n\nPlease pay urgently to avoid additional charges. Contact us immediately if you are experiencing difficulty.",

  // From WA_TEMPLATES.payment_overdue_7d. The fixed "7 days" became the real
  // count: today its only caller is the 60-day DEFAULTED escalation.
  loan_overdue_7d:
    "URGENT - {{firstName}}\n\nLoan *{{reference}}* is *{{daysOverdue}} days overdue*. Outstanding: *{{amount}}*.\n\nPlease contact us immediately: {{supportPhone}}\n\nFurther action will be taken if payment is not received.",
}

/**
 * The variables an event supplies, keyed by the names its body uses.
 *
 * Returns only what that event's body needs: `send.ts` checks that every
 * placeholder is present and non-blank, so supplying a value that is always
 * empty is as harmful as omitting it.
 */
export function waTemplateVarsFor(
  event: string,
  src: WaTemplateVarSource,
): Record<string, string> {
  switch (event) {
    case "application_submitted":
      return { firstName: src.firstName, reference: src.reference, amount: src.amount }
    case "loan_approved":
      return { firstName: src.firstName, amount: src.amount, reference: src.reference }
    case "application_declined":
      return { firstName: src.firstName, reference: src.reference }
    case "loan_disbursed":
      return { firstName: src.firstName, amount: src.amount, dueDate: src.dueDate }
    case "payment_received":
      return { firstName: src.firstName, amount: src.amount, outstanding: src.outstanding }
    case "payment_due_3d":
      return {
        firstName: src.firstName,
        amount: src.amount,
        dueDate: src.dueDate,
        reference: src.reference,
      }
    case "agent_reengagement":
      return { firstName: src.firstName }
    case "payment_reminder_7d":
      return {
        firstName: src.firstName,
        amount: src.amount,
        dueDate: src.dueDate,
        reference: src.reference,
      }
    case "payment_reminder_1d":
      return { amount: src.amount, dueDate: src.dueDate, reference: src.reference }
    case "payment_reminder_0d":
    case "payment_reminder_0d_v2":
      return { amount: src.amount, reference: src.reference, supportPhone: src.supportPhone }
    case "payment_reminder_overdue_1d":
      return { amount: src.amount, reference: src.reference }
    case "payment_reminder_overdue_3d":
      return { reference: src.reference, outstanding: src.outstanding, supportPhone: src.supportPhone }
    case "loan_overdue_1d":
      return { firstName: src.firstName, amount: src.amount, reference: src.reference }
    case "loan_overdue_7d":
      return {
        firstName: src.firstName,
        reference: src.reference,
        daysOverdue: src.daysOverdue ?? "",
        amount: src.amount,
        supportPhone: src.supportPhone,
      }
    default:
      return {}
  }
}
