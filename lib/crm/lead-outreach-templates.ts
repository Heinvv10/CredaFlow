// The three one-click CRM outreach messages, and their POPIA classification.
//
// ── Compliance note (revisit with legal before changing the copy or the
//    category) ──────────────────────────────────────────────────────────────
// All three are TemplateCategory.SERVICE. The basis is that each one services
// an enquiry the lead *themselves* opened — they asked us for a loan and these
// messages progress or close that request. SERVICE clears the eligibility
// engine's Lane 5 (lib/messaging/eligibility.ts), so it is still refused for a
// BLOCKED contact or one who has opted out of the channel, but it does not
// require marketing consent.
//
// That classification is only defensible while the copy stays true to it. The
// re-engage message in particular must reference the lead's OWN open
// application and offer to close it — it must never promote a product or
// quote a rate ("still need cash? rates from X%"), which would be POPIA s.69
// direct marketing to someone who never consented. Nothing in this codebase
// grants MARKETING_GENERAL consent, so a MARKETING template to a lead is
// refused 100% of the time; do not "fix" a blocked send by relabelling copy
// as SERVICE — fix the copy, or get consent.
//
// ── Why WhatsApp only ─────────────────────────────────────────────────────
// Every message here asks the lead to reply, and SMS is send-only in this
// system: `app/api/webhooks/whatsapp/route.ts` is the ONLY inbound webhook,
// lib/integrations/bulksms.ts exports just sendSms/sendWhatsApp, and the comms
// spec still lists "SMS inbound threading parity" as future work. Over SMS the
// lead's answer — and their STOP — would be silently dropped, so "Reply STOP
// to opt out" would be a promise the system cannot keep.
//
// WhatsApp is genuinely bidirectional: the webhook routes replies into the
// agent inbox and STOP_REGEX → handleWaStopInbound (lib/messaging/wa-stop.ts)
// revokes consent. So every instruction in the copy below is true.
//
// Adding SMS requires inbound SMS first (BulkSMS MO provisioning + a webhook +
// STOP handling + routing into Conversation/Message) — not a copy change.
// The channel stays in the key/type shape so that lands cleanly.

export type OutreachChannel = "WHATSAPP"

export type LeadOutreachKind = "QUALIFICATION" | "REQUEST_DOCS" | "REENGAGE"

export type LeadOutreachDefinition = {
  kind: LeadOutreachKind
  label: string
  /** What the button says it will do — shown to staff before they send. */
  description: string
  /** Per-channel body. `{{var}}` names must match buildOutreachVars(). */
  body: Record<OutreachChannel, string>
}

export const LEAD_OUTREACH: Record<LeadOutreachKind, LeadOutreachDefinition> = {
  QUALIFICATION: {
    kind: "QUALIFICATION",
    label: "Qualification",
    description: "Ask for the income + employment details needed to qualify them",
    body: {
      WHATSAPP:
        "Hi {{firstName}}, this is {{agentName}} following up on your loan enquiry with us. " +
        "To check what you qualify for, please reply with: 1) your monthly income after deductions, " +
        "2) whether you are permanently employed, and 3) the amount you need. Reply STOP to opt out.",
    },
  },
  REQUEST_DOCS: {
    kind: "REQUEST_DOCS",
    label: "Request documents",
    description: "Ask for ID, payslips and bank statements to progress the application",
    body: {
      // Deliberately does NOT say "reply here with photos". The WhatsApp
      // webhook drops any message without a text body
      // (app/api/webhooks/whatsapp/route.ts: `if (!fromPhone || !text) return null`),
      // so a photo of an SA ID sent here is silently discarded — no Message
      // row, no DocumentAccessLog, no retention. The lead would believe they
      // had submitted their KYC when nothing received it. Ask them to say when
      // the documents are ready and let the consultant arrange collection.
      WHATSAPP:
        "Hi {{firstName}}, {{agentName}} here. To take your application further we need: " +
        "1) your SA ID, 2) your 3 most recent payslips, and 3) your last 3 months of bank statements. " +
        "Please reply here once you have them together and I will arrange how to send them in safely. " +
        "Reply STOP to opt out.",
    },
  },
  REENGAGE: {
    kind: "REENGAGE",
    label: "Re-engage",
    description: "Nudge a quiet lead about their own open application",
    body: {
      // Deliberately about THEIR open application, not a product pitch. See
      // the compliance note above.
      //
      // It does NOT offer to "close it off" on STOP, however tempting the
      // symmetry: handleWaStopInbound (lib/messaging/wa-stop.ts) revokes the
      // channel's ContactConsent and nothing else — it never touches
      // Lead.status, so nothing would be closed. STOP stops the messages, so
      // that is all this may promise.
      WHATSAPP:
        "Hi {{firstName}}, {{agentName}} here. Your loan application with us is still open " +
        "and we have not heard back from you. If you would like to carry on, reply here and we will pick up " +
        "where we left off. If you would rather not, reply STOP and we will stop messaging you here.",
    },
  },
}

export const LEAD_OUTREACH_KINDS = Object.keys(LEAD_OUTREACH) as LeadOutreachKind[]

export function isLeadOutreachKind(v: unknown): v is LeadOutreachKind {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a request body
  // of {"kind":"constructor"} would pass the guard and then index
  // LEAD_OUTREACH["constructor"] to Object's constructor.
  return typeof v === "string" && Object.hasOwn(LEAD_OUTREACH, v)
}

// SMS is deliberately absent — see "Why WhatsApp only" above. Rejecting it
// here means a hand-crafted request cannot send an SMS whose reply and STOP
// would be silently dropped.
export function isOutreachChannel(v: unknown): v is OutreachChannel {
  return v === "WHATSAPP"
}

/**
 * MessageTemplate is unique on (tenantId, key), so the channel is part of the
 * key — when SMS lands it is a separate template row, not a variant of this
 * one. Mirrors the `agent_message_whatsapp` / `agent_message_sms` convention.
 */
export function outreachTemplateKey(kind: LeadOutreachKind, channel: OutreachChannel): string {
  return `lead_${kind.toLowerCase()}_${channel.toLowerCase()}`
}

/** Used when a staff account has no name set. */
export const AGENT_NAME_FALLBACK = "your consultant"

/** Longest a substituted value may be in an outreach body. */
export const MAX_VAR_LENGTH = 40

/**
 * Sanitise a value interpolated into an outreach body.
 *
 * The rendered text IS the sink. There is no HTML context here — the WhatsApp
 * provider dispatches a plain string — but that is precisely why this is
 * needed rather than why it isn't: the message body itself is the payload, so
 * an attacker needs no markup, only the ability to write text into it.
 *
 * `Lead.firstName` is attacker-controlled: a member of the public types it
 * into app/api/website/apply (which accepts it on a truthiness check alone —
 * no cap, no charset filter) with any phone number they like, unverified.
 * Without this, POSTing a victim's phone and a firstName of
 * "Thabo\n\nAcme Lending: your payout is on hold, pay R250 to 123456789"
 * turns one staff click into attacker-authored text delivered from the
 * lender's verified WhatsApp identity.
 *
 * Newlines are the actual weapon: the lead detail <h1> collapses them, so the
 * payload reads as an oddly long name on screen and as a clean separate
 * paragraph on WhatsApp — the staff member cannot see what they are sending.
 *
 * `maxLength` defaults to MAX_VAR_LENGTH (every outreach call site). The
 * staff task reminder (lib/notifications/task-reminder.ts) passes a larger cap
 * for a task title, and shares this function rather than copying it: the
 * flattening — not the truncation — is the security control, and a second
 * divergent copy of it is exactly how one sink later loses the fix.
 */
export function sanitiseOutreachVar(value: string, maxLength: number = MAX_VAR_LENGTH): string {
  const flattened = value
    // Newlines, line/paragraph separators and C0/C1 control characters all
    // collapse to a single space — nothing may open a new line in the body.
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return flattened.length > maxLength
    ? `${flattened.slice(0, maxLength - 1)}\u2026`
    : flattened
}

/**
 * How the sending agent is introduced in outreach copy: first name only.
 *
 * "Pieter van der Merwe" → "Pieter". Reads the way a person introduces
 * themselves, and keeps a staff member's work email out of every lead's
 * WhatsApp: `User.name` is free text from the admin form
 * (app/api/settings/users, no format validation), so an account literally
 * named "thabo@lender.example" has no whitespace to split on and would
 * otherwise be published verbatim. Guarding only the null-fallback was not
 * enough — the input needed guarding too.
 */
export function agentDisplayName(fullName: string | null | undefined): string {
  const first = sanitiseOutreachVar(fullName ?? "").split(" ")[0] ?? ""
  if (!first || first.includes("@")) return AGENT_NAME_FALLBACK
  return first
}

/**
 * The exact body that will be delivered, for the staff confirm step.
 *
 * Uses the same substitution and the same sanitiser as the send path
 * (buildOutreachVars → renderTemplate), so what the agent approves and what
 * the lead receives cannot diverge. That equivalence is the point: without a
 * preview the one-click send is a blind click, and `firstName` is public-form
 * input.
 */
export function renderOutreachPreview(
  kind: LeadOutreachKind,
  vars: { firstName: string; agentName: string }
): string {
  const safe: Record<string, string> = {
    firstName: sanitiseOutreachVar(vars.firstName),
    agentName: sanitiseOutreachVar(vars.agentName),
  }
  return LEAD_OUTREACH[kind].body.WHATSAPP.replace(
    // Object.hasOwn for the same reason isLeadOutreachKind uses it: `safe[name]`
    // alone reads the prototype chain, so a `{{constructor}}` placeholder would
    // interpolate Object's constructor rather than fall through.
    /\{\{(\w+)\}\}/g,
    (_m, name: string) => (Object.hasOwn(safe, name) ? safe[name] : `{{${name}}}`)
  )
}
