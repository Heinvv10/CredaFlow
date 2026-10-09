import type { Channel, ConsentPurpose, MessageTemplate, Provider } from "@prisma/client"
import type { EmailAttachment } from "@/lib/email/service"

export type LawfulBasis =
  | "EXPLICIT_OPT_IN"
  | "S69_SOFT_OPT_IN"
  | "SERVICE_COMMS_NCA"
  | "TRANSACTIONAL_OPERATIONAL"
  | "STATUTORY_OVERRIDE"

export type EligibilityReason =
  | "NO_CONSENT_ON_FILE"
  | "REVOKED"
  | "BLOCKED"
  | "OUTSIDE_WA_SESSION_WINDOW"
  | "CHANNEL_OPTED_OUT"
  | "NOT_ELIGIBLE_MARKETING_OBJECTED"
  | "NOT_ELIGIBLE_INSURANCE_S69_OPINION_PENDING"

export type Eligibility =
  | { ok: true; basis: LawfulBasis; consentId?: string; evidence: string }
  | { ok: false; reason: EligibilityReason }

export type EligibilityTemplate = Pick<
  MessageTemplate,
  "id" | "tenantId" | "key" | "category" | "purposeRequired" | "statutoryOverride"
>

// Suppress unused import — Channel and ConsentPurpose are re-exported for
// callers who import from this module rather than @prisma/client directly.
export type { Channel, ConsentPurpose }

import type { prisma } from "@/lib/prisma"

/**
 * Structural duck type: both the extended global `prisma` client and the
 * transaction client from prisma.$transaction(async tx => ...) expose these
 * model delegates. Using Pick<typeof prisma, ...> captures the extended-client
 * shape that TypeScript infers for `prisma`; the tx client is assignable to
 * it because it has the same model delegates.
 *
 * Used by evaluateEligibility so canSend (global client) and canSendTx
 * (transaction client + FOR UPDATE lock) share one regulatory-lane
 * implementation. $queryRawUnsafe is on the canSendTx parameter type in
 * send.ts (not needed by the evaluator itself).
 */
export type PrismaLike = Pick<typeof prisma, "contact" | "contactConsent" | "tenant" | "conversation" | "message">

export type { RenderedTemplate } from "./render"

export type SendMessageOpts = {
  contactId: string
  channel: Channel
  template: MessageTemplate
  vars: Record<string, string>
  toValue: string
  // Email-only display name. Reaches the To header and the EmailLog row.
  toName?: string
  conversationId?: string
  loanId?: string
  applicationId?: string
  createdById?: string
  category?: string
  // Durable business-event reservation. Reusing the same key returns the
  // existing Message and never crosses the provider boundary a second time.
  idempotencyKey?: string
  // Explicit operator-authorised retry of the SAME business occurrence.
  // Only a terminal Message whose last provider attempt is durably
  // DEFINITELY_REJECTED can be re-armed; ambiguous/accepted/simulated and
  // retry-worker-owned rows remain no-replay. The actor is persisted in the
  // same transaction as the state transition.
  rearmDefinitelyRejected?: {
    userId: string
    userEmail: string
    reason: string
  }
  // Email-only. Routes replies somewhere other than the From address.
  // Used by S129 sends so noreply@ (DKIM-aligned) stays as From while
  // replies land in collections@.
  replyTo?: string
  // Email-only. File + inline attachments. Inline images set `cid` and
  // are referenced from the HTML body via `cid:<cid>`.
  attachments?: EmailAttachment[]
  // Statutory/legal dispatches with non-replayable evidence (for example a
  // Section 129 PDF bound to a separate compliance lifecycle) must never be
  // replayed by the generic body-only retry cron. Their owning workflow
  // reconciles an uncertain provider outcome explicitly.
  automaticRetry?: boolean
  // Statutory workflows use this synchronous signal to distinguish failures
  // in message preparation from failures after provider dispatch begins. It is
  // passed through the adapter and invoked immediately before external delivery.
  onProviderDispatchStart?: () => void
  // Email-only RFC 5322 threading headers. `inReplyTo` is the Message-ID of
  // the message being replied to; `references` is the full thread chain. Set
  // by the inbox reply path so the customer's mail client keeps the thread
  // together. Ignored for non-email channels.
  inReplyTo?: string
  references?: string[]
}

export type ProviderName = Provider
