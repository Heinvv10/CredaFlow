import { prisma } from "@/lib/prisma"
import { lookupContactByChannelValue } from "@/lib/contact/identity"
import { sendMessage, SendBlockedError } from "./send"
import { MessageReconciliationRequiredError } from "./dispatch-control"
import { providerFailureOutcome } from "./providers"
import type { SendMessageOpts } from "./types"
import type { Channel, Contact, MessageTemplate } from "@prisma/client"

/**
 * The delivery verdict shape the client-facing routes already speak — the same
 * one `sendEmail()` returns — so a route can swap between the legacy direct
 * send and sendMessage() without changing its audit, POPIA-disclosure or
 * response logic.
 */
export type RouteDeliveryOutcome = {
  ok: boolean
  // TRUE when the send was locally simulated rather than handed to a real
  // provider (BULKSMS_DRY_RUN, and it is `true` on prod today). A caller that
  // omits this and audits an unconditional "sent" writes a FALSE COMPLIANCE
  // RECORD — the legacy sendSms/sendWhatsApp helpers returned this field and
  // their callers read it, so dropping it here silently degraded to `false`.
  simulated?: boolean
  error?: string
  providerOutcome?: "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
}

export type MessagingTarget =
  | { ok: true; contact: Contact; template: MessageTemplate }
  | { ok: false; reason: string }

/**
 * Resolve the Contact row the Message hangs off and the seeded template.
 *
 * Both misses are DATA DRIFT, not ordinary outcomes: a Client with no Contact
 * row means the identity backfill missed someone, and a missing template means
 * the flag was flipped ahead of the migration. Neither may be swallowed into a
 * silent no-send — the caller gets a reason to surface and audit.
 *
 * `value` must already be normalised for the channel (normaliseEmail /
 * normalisePhone / toWaJid) — the ContactIdentity index is strict-equality.
 */
export async function resolveMessagingTarget(opts: {
  tenantId: string
  channel: Channel
  value: string
  templateKey: string
}): Promise<MessagingTarget> {
  const contact = await lookupContactByChannelValue(prisma, {
    tenantId: opts.tenantId,
    channel: opts.channel,
    value: opts.value,
  })
  if (!contact) {
    return { ok: false, reason: `no Contact row for this ${opts.channel.toLowerCase()} address` }
  }
  const template = await prisma.messageTemplate.findFirst({
    // `active` is honoured: a template an operator deactivated in the admin UI
    // must stop sending, not keep sending because this lookup ignored the flag.
    where: { tenantId: opts.tenantId, key: opts.templateKey, channel: opts.channel, active: true },
  })
  if (!template) {
    return { ok: false, reason: `the ${opts.templateKey} message template is not seeded or is inactive for this tenant` }
  }
  return { ok: true, contact, template }
}

/**
 * Run one sendMessage() and translate its outcome into a delivery verdict.
 *
 * The distinction that matters is AMBIGUOUS vs DEFINITELY_REJECTED: callers
 * use it to decide whether a POPIA disclosure record must exist and whether a
 * consumer may have received the document. Never collapse an ambiguous
 * provider outcome into a definite rejection — that would claim proven
 * non-delivery of something that may well have arrived.
 */
/**
 * Statuses that mean the message actually went somewhere. Anything else —
 * FAILED_PERMANENT and RETRYING from a definite provider rejection,
 * SUPPRESSED_BY_CONSENT, EXPIRED, BOUNCED, or a still-QUEUED row — is NOT a
 * send, and sendMessage RETURNS those rather than throwing when it owns the
 * retry. Guarding on the status is explicit; relying on every caller passing
 * `automaticRetry: false` is the incidental protection this codebase has been
 * bitten by before.
 */
const DELIVERED_STATUSES = ["SENT", "DELIVERED", "READ", "SIMULATED"]

export async function deliverViaMessaging(opts: SendMessageOpts): Promise<RouteDeliveryOutcome> {
  // Did the provider boundary get crossed at all? Every channel signals this
  // immediately before external delivery (providers.ts fires it for SMS and
  // WhatsApp; sendEmail fires it for both Graph and SMTP), so a false here
  // means the throw below happened strictly BEFORE dispatch and is a proven
  // non-send: no email config, a missing template var, the redaction guard,
  // an idempotency conflict, or any Prisma error in the reservation.
  //
  // This matters because the callers turn AMBIGUOUS into a POPIA disclosure
  // record and tell the officer the document "may have reached the client".
  // Recording a disclosure that provably never happened is the same class of
  // false compliance record as auditing a dry-run as a real send.
  let providerInvoked = false
  const callerDispatchHook = opts.onProviderDispatchStart

  try {
    const message = await sendMessage({
      ...opts,
      onProviderDispatchStart: () => {
        providerInvoked = true
        callerDispatchHook?.()
      },
    })

    if (!DELIVERED_STATUSES.includes(message.status)) {
      return {
        ok: false,
        error: message.errorMessage ?? `message terminated as ${message.status}`,
        // It reached this state through a dispatch attempt, so honour whatever
        // the attempt concluded rather than asserting a clean non-send.
        providerOutcome: providerInvoked ? "AMBIGUOUS" : "DEFINITELY_REJECTED",
      }
    }

    // A simulated dispatch never crossed a provider boundary. Report it as
    // such so the caller cannot audit it as a real send.
    const simulated = message.status === "SIMULATED"
      || message.dispatchState === "SIMULATED"
      || message.simulationReceiptId != null
    return { ok: true, simulated, providerOutcome: "ACCEPTED" }
  } catch (err) {
    if (err instanceof SendBlockedError) {
      // Eligibility refused the send. No Message row, nothing left the system.
      return { ok: false, error: `send blocked: ${err.reason}`, providerOutcome: "DEFINITELY_REJECTED" }
    }
    if (err instanceof MessageReconciliationRequiredError) {
      // AMBIGUOUS even when providerInvoked is false. This error also covers
      // the idempotent-replay branch, where an EARLIER attempt on the same
      // reservation may well have been delivered — this call not touching a
      // provider says nothing about that one.
      return { ok: false, error: err.message, providerOutcome: "AMBIGUOUS" }
    }
    if (!providerInvoked) {
      // Provably pre-dispatch. Legacy sendEmail() already returned
      // DEFINITELY_REJECTED for the no-config case, so without this the
      // cutover would convert a clean "check your email settings" into a
      // forged disclosure record.
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        providerOutcome: "DEFINITELY_REJECTED",
      }
    }
    // Dispatch was entered. AMBIGUOUS stays the fail-safe default for anything
    // that is not a typed ProviderDispatchError.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      providerOutcome: providerFailureOutcome(err),
    }
  }
}
