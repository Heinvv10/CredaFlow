import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { evaluateEligibility } from "./eligibility"
import { renderTemplate } from "./render"
import { providerFailureOutcome } from "./providers"
import { classifyError, backoff } from "./retry"
import { signUnsubToken } from "@/lib/unsubscribe/token"
import type { Channel, Message, MessageTemplate, Provider } from "@prisma/client"
import type { Eligibility, EligibilityReason, PrismaLike, SendMessageOpts } from "./types"
import { lockContactConsentSubject } from "./consent-lock"
import { requiresMessageReconciliation } from "./reconciliation"
import { dispatchWithinTimeout } from "./provider-timeout"
import {
  MessageDispatchConflictError,
  MessageReconciliationRequiredError,
  closeExternallyOwnedMessageDispatch,
  completeMessageDispatch,
  failMessageDispatchDefinitely,
  holdMessageDispatchForReconciliation,
  newMessageDispatchControl,
  validateMessageIdempotencyKey,
} from "./dispatch-control"
import { messagePayloadFingerprint } from "./payload-fingerprint"
import { REDACTED_BODY_PLACEHOLDER, storedBodyFor } from "./redaction"
import { buildTemplateComponents, extractPlaceholders, extractButtonPlaceholders, readSendButtons, type WaTemplateRef } from "@/lib/whatsapp/template-components"
import { resolveOpenThreadForContact, type ResolveThreadTx } from "@/lib/inbox/resolve-thread"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"

export { MessageReconciliationRequiredError } from "./dispatch-control"

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const PREPARATION_ATTEMPTS = 3

function isSerializableWriteConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "P2034"
}

async function retrySerializablePreparation<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= PREPARATION_ATTEMPTS; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isSerializableWriteConflict(error) || attempt === PREPARATION_ATTEMPTS) throw error
    }
  }
  throw lastError
}

function buildListUnsubscribeUrl(
  channel: Channel,
  contactId: string,
  template: Pick<MessageTemplate, "statutoryOverride">,
  preparedAt = new Date(),
): string | undefined {
  if (channel !== "EMAIL") return undefined
  // Statutory mail (NCA s.129, court process, anything that bypasses
  // canSend via statutoryOverride) MUST NOT offer an unsubscribe — the
  // recipient cannot lawfully opt out of a notice the law requires us
  // to send. Suppress the header at the source rather than relying on
  // the handler to ignore revocations.
  if (template.statutoryOverride) return undefined
  const secret = process.env.UNSUB_TOKEN_SECRET
  if (!secret) {
    // Misconfigured non-production environment: skip the header rather than
    // fail the send. A production deployment must set UNSUB_TOKEN_SECRET.
    return undefined
  }
  const exp = preparedAt.getTime() + NINETY_DAYS_MS
  const token = signUnsubToken({ contactId, channel: "EMAIL", purpose: "MARKETING_GENERAL", exp }, secret)
  const base = requireAppBaseUrl()
  return `${base}/api/messaging/unsubscribe?uns=${encodeURIComponent(token)}`
}

/**
 * A redacted row still carries `payloadFingerprint`, computed over the TRUE
 * payload. Everything else in that canonical object is knowable to anyone with
 * DB read, so the only thing standing between them and the redacted secret is
 * its own search space — and a 6-digit OTP is 10^6 hashes. The one unknowable
 * term is the signed List-Unsubscribe token, which exists only when
 * UNSUB_TOKEN_SECRET is set (see buildListUnsubscribeUrl).
 *
 * UNSUB_TOKEN_SECRET may be unset in non-production environments — exactly
 * where walkthroughs happen. Refuse the send rather than write a row
 * whose secret is recoverable from itself. Thrown before the transaction, so
 * no Message is reserved and nothing reaches a provider.
 *
 * LIMIT, stated plainly: this does NOT protect a statutoryOverride template,
 * whose unsubscribe URL is suppressed by law regardless of the secret. Those
 * are safe today only because their redacted payload (a tokenised signing
 * link) is high-entropy rather than a 6-digit code. A per-message stored salt
 * in the fingerprint is the durable fix; it needs its own column and is not in
 * this change.
 */
function assertRedactedSendIsRecoverable(
  channel: Channel,
  template: Pick<MessageTemplate, "redactStoredBody" | "statutoryOverride" | "key">,
): void {
  if (!template.redactStoredBody) return
  if (channel !== "EMAIL") return
  if (template.statutoryOverride) return
  if (process.env.UNSUB_TOKEN_SECRET) return
  throw new Error(
    `Refusing to send redacted template "${template.key}": UNSUB_TOKEN_SECRET is not set, `
    + "so the redacted body would be recoverable by brute-forcing its own payloadFingerprint. "
    + "Set UNSUB_TOKEN_SECRET in this environment before enabling this send.",
  )
}

// Transaction client type: PrismaLike model delegates + $queryRawUnsafe for
// the FOR UPDATE lock that canSendTx issues before calling evaluateEligibility.
type TxClient = PrismaLike & {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>
}

export class SendBlockedError extends Error {
  reason: EligibilityReason
  constructor(reason: EligibilityReason) {
    super(`send blocked: ${reason}`)
    this.name = "SendBlockedError"
    this.reason = reason
  }
}

export class MessageIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already reserved for a different message request")
    this.name = "MessageIdempotencyConflictError"
  }
}

export type KnownDispatchOutcome = "PROVIDER_ACCEPTED" | "SIMULATED"

export type KnownDispatchEvidence = {
  outcome: KnownDispatchOutcome
  providerMessageId?: string
  providerAcceptedAt?: Date
  evidenceReference?: string
  simulationReceiptId?: string
}

/**
 * The provider outcome is known, but neither terminal Message write could be
 * persisted. Callers must not collapse this into an ordinary dispatch failure:
 * the real provider may already have accepted the message, or the dry-run may
 * have been simulated without any outbound traffic.
 */
export class KnownDispatchPersistenceError extends MessageReconciliationRequiredError {
  readonly outcome: KnownDispatchOutcome
  readonly messageId: string
  readonly providerMessageId?: string
  readonly providerAcceptedAt?: Date
  readonly evidenceReference?: string
  readonly simulationReceiptId?: string
  readonly firstWriteError: unknown
  readonly recoveryWriteError: unknown
  readonly holdWriteError: unknown
  readonly evidenceAuditWriteError: unknown

  constructor(args: {
    outcome: KnownDispatchOutcome
    message: Message
    providerMessageId?: string
    providerAcceptedAt?: Date
    evidenceReference?: string
    simulationReceiptId?: string
    firstWriteError: unknown
    recoveryWriteError: unknown
    holdWriteError: unknown
    evidenceAuditWriteError?: unknown
  }) {
    super(
      args.message,
      args.outcome === "SIMULATED"
        ? "Simulation completed, but its terminal message status could not be persisted"
        : "Provider accepted the message, but its terminal status could not be persisted",
    )
    this.name = "KnownDispatchPersistenceError"
    this.outcome = args.outcome
    this.messageId = args.message.id
    this.providerMessageId = args.providerMessageId
    this.providerAcceptedAt = args.providerAcceptedAt
    this.evidenceReference = args.evidenceReference
    this.simulationReceiptId = args.simulationReceiptId
    this.firstWriteError = args.firstWriteError
    this.recoveryWriteError = args.recoveryWriteError
    this.holdWriteError = args.holdWriteError
    this.evidenceAuditWriteError = args.evidenceAuditWriteError
  }
}

export function knownDispatchEvidenceFromError(
  error: KnownDispatchPersistenceError,
): KnownDispatchEvidence {
  return {
    outcome: error.outcome,
    ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
    ...(error.providerAcceptedAt ? { providerAcceptedAt: error.providerAcceptedAt } : {}),
    ...(error.evidenceReference ? { evidenceReference: error.evidenceReference } : {}),
    ...(error.simulationReceiptId ? { simulationReceiptId: error.simulationReceiptId } : {}),
  }
}

/**
 * Transactional eligibility check. Acquires FOR UPDATE locks on the
 * latest-effective ContactConsent rows the evaluator will read, then
 * delegates to the same lane-by-lane evaluator canSend uses.
 *
 * The FOR UPDATE lock defuses the race where a customer's STOP keyword
 * writes a REVOKED ContactConsent row between our eligibility check and
 * the Message insert. Under Serializable + the lock, one of the two
 * concurrent transactions retries.
 */
export async function canSendTx(
  tx: TxClient,
  contactId: string,
  channel: Channel,
  template: MessageTemplate,
): Promise<Eligibility> {
  await lockContactConsentSubject(tx, {
    tenantId: template.tenantId,
    contactId,
  })

  // Lock the latest-effective ContactConsent rows for the (contactId, channel)
  // bundle the evaluator will read: (channel, SERVICE_COMMS) for the channel
  // opt-out check, (channel, purposeRequired) for the marketing lane, and the
  // ALL_CHANNELS fallback rows for channel-agnostic purposes.
  //
  // $queryRawUnsafe because $queryRaw template-string mode rejects WITH
  // dynamic IN-list construction in Prisma 5; the values here are constants
  // + already-validated identifiers (no user input concatenated).
  await tx.$queryRawUnsafe(
    `SELECT id FROM "ContactConsent"
       WHERE "tenantId" = $1
         AND "contactId" = $2
         AND "effectiveTo" IS NULL
         AND ("channel" = $3::"Channel" OR "channel" = 'ALL_CHANNELS')
       FOR UPDATE`,
    template.tenantId,
    contactId,
    channel,
  )

  return evaluateEligibility(tx, contactId, channel, template)
}

export async function resolveProvider(channel: Channel, tenantId?: string): Promise<Provider> {
  switch (channel) {
    case "EMAIL": {
      if (!tenantId) throw new Error("tenantId is required to resolve an email provider")
      const config = await prisma.emailConfig.findUnique({
        where: { tenantId },
        select: { active: true, provider: true },
      })
      if (!config?.active) throw new Error("Email is not configured for this tenant")
      return config.provider === "MSGRAPH" ? "MSGRAPH" : "SMTP"
    }
    case "SMS":      return "BULKSMS" as Provider
    case "WHATSAPP": {
      if (!tenantId) return "WA_UNOFFICIAL" as Provider
      const settings = await prisma.commsSettings.findUnique({
        where: { tenantId },
        select: { waProvider: true },
      })
      return (settings?.waProvider === "WA_CLOUD" ? "WA_CLOUD" : "WA_UNOFFICIAL") as Provider
    }
    case "VOICE":    throw new Error("voice channel dispatch is not supported")
    case "MANUAL":   throw new Error("manual channel does not have a dispatch provider")
    case "ALL_CHANNELS": throw new Error("ALL_CHANNELS is a consent-scope sentinel, not a real channel")
    case "CHATBOT":  throw new Error("chatbot channel dispatch is not supported")
    default: {
      const _exhaustive: never = channel
      throw new Error(`unsupported channel: ${_exhaustive}`)
    }
  }
}

/**
 * Returns the conversationId for the Message about to be inserted.
 * Priority: explicit opts.conversationId > the contact's single open
 * Conversation > a new OPEN Conversation carrying this send's channel.
 *
 * Channel is NOT part of the lookup. A contact has one open thread; an email
 * and a WhatsApp both land in it, and Message.channel records which was which.
 * CLOSED threads are still never reused — that is an operator decision.
 */
export async function resolveOrCreateConversationTx(
  tx: PrismaLike,
  opts: SendMessageOpts,
): Promise<string> {
  if (opts.conversationId) return opts.conversationId

  const resolved = await resolveOpenThreadForContact(tx as unknown as ResolveThreadTx, {
    tenantId: opts.template.tenantId,
    contactId: opts.contactId,
    channel: opts.channel,
    now: new Date(),
    loanId: opts.loanId ?? null,
    applicationId: opts.applicationId ?? null,
  })
  return resolved.id
}

/**
 * The single outbound entry point for every customer-facing channel.
 *
 * Render → Serializable tx { canSendTx → resolveOrCreateConversation →
 * insert Message[QUEUED] } → dispatch (post-commit) → update SENT/FAILED.
 *
 * Throws SendBlockedError on eligibility block (no Message row).
 * Returns the durable RETRYING/FAILED_PERMANENT Message when the provider
 * definitely rejected an automatically managed attempt. Ambiguous provider
 * outcomes still throw MessageReconciliationRequiredError; externally owned
 * statutory workflows still receive their provider error.
 *
 * Invariant: a message the provider accepted MUST NEVER be recorded as
 * FAILED. If the post-dispatch SENT-transition DB write
 * throws, we retry it once; if that also throws we emit a distinct
 * MESSAGE_SENT_DB_WRITE_FAILED audit row and leave the Message in
 * QUEUED state — so ops can fix the row manually rather than lying.
 */
export async function sendMessage(opts: SendMessageOpts): Promise<Message> {
  const rendered = renderTemplate(opts.template as Parameters<typeof renderTemplate>[0], opts.vars)
  // What gets PERSISTED. Identical to `rendered` unless the template is
  // flagged redactStoredBody, in which case the body is replaced by a
  // placeholder so a one-time code or signing link never lands on the
  // staff-visible comms timeline. `rendered` — the true body — is what
  // reaches the provider and what the fingerprint is computed over.
  const stored = storedBodyFor(opts.template, rendered)
  assertRedactedSendIsRecoverable(opts.channel, opts.template)
  const provider = await resolveProvider(opts.channel, opts.template.tenantId)
  const idempotencyKey = validateMessageIdempotencyKey(opts.idempotencyKey)
  // Generic retries persist only rendered text. Email also carries headers and
  // optional attachment bytes, so its owning caller must explicitly replay the
  // exact fingerprinted request after a definite rejection.
  const externallyOwnedDispatch = opts.automaticRetry === false
  const automaticRetry = opts.channel !== "EMAIL" && !externallyOwnedDispatch
  const requestPreparedAt = new Date()
  const preparePayload = (preparedAt: Date) => {
    const listUnsubscribeUrl = buildListUnsubscribeUrl(
      opts.channel,
      opts.contactId,
      opts.template,
      preparedAt,
    )
    return {
      listUnsubscribeUrl,
      payloadFingerprint: messagePayloadFingerprint({
        tenantId: opts.template.tenantId,
        contactId: opts.contactId,
        channel: opts.channel,
        provider,
        templateId: opts.template.id,
        rendered,
        toValue: opts.toValue,
        toName: opts.toName,
        conversationId: opts.conversationId,
        loanId: opts.loanId,
        applicationId: opts.applicationId,
        category: opts.category,
        replyTo: opts.replyTo,
        listUnsubscribeUrl,
        attachments: opts.attachments,
        inReplyTo: opts.inReplyTo,
        references: opts.references,
        automaticRetry,
        failureOwner: externallyOwnedDispatch ? "CALLER" : "MESSAGING",
      }),
    }
  }
  if (opts.rearmDefinitelyRejected && !idempotencyKey) {
    throw new Error("A durable idempotency key is required to re-arm a definitely rejected message")
  }

  // Provider dispatch has not started yet, so a PostgreSQL Serializable
  // write-conflict is safe to retry. This is required under concurrent load:
  // P2034 aborts the whole transaction and therefore cannot have committed a
  // Message reservation or crossed the provider boundary.
  const prepared = await retrySerializablePreparation(() => prisma.$transaction(async (tx) => {
    const txClient = tx as unknown as TxClient
    let rearmCandidate: Message | null = null
    if (idempotencyKey) {
      await txClient.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `${opts.template.tenantId}:${idempotencyKey}`,
      )
      const existing = await tx.message.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: opts.template.tenantId,
            idempotencyKey,
          },
        },
      })
      if (existing) {
        const preparedPayload = preparePayload(existing.createdAt ?? requestPreparedAt)
        // Channel is deliberately absent: one open thread per contact means a
        // replayed key can legitimately resolve a thread whose Conversation.
        // channel differs from this send's channel. The identity that matters
        // — existing.channel === opts.channel — is still asserted in
        // `sameRequest` below, and the payload fingerprint covers the rest.
        const matchingConversation = await tx.conversation.findFirst({
          where: {
            id: existing.conversationId,
            tenantId: opts.template.tenantId,
            contactId: opts.contactId,
          },
          select: { id: true },
        })
        const sameRequest =
          matchingConversation !== null &&
          (!opts.conversationId || existing.conversationId === opts.conversationId) &&
          existing.direction === "OUTBOUND" &&
          existing.channel === opts.channel &&
          existing.provider === provider &&
          existing.templateId === opts.template.id &&
          existing.subject === (stored.subject ?? null) &&
          existing.bodyText === stored.text &&
          existing.bodyHtml === (stored.html ?? null) &&
          existing.toValue === opts.toValue &&
          existing.payloadFingerprint !== null &&
          existing.payloadFingerprint === preparedPayload.payloadFingerprint
        if (!sameRequest) throw new MessageIdempotencyConflictError()

        const terminalDefinitelyRejected =
          existing.dispatchState === "DEFINITELY_REJECTED" &&
          ["FAILED_PERMANENT", "EXPIRED", "SUPPRESSED_BY_CONSENT"].includes(existing.status)
        if (opts.rearmDefinitelyRejected && terminalDefinitelyRejected) {
          if (
            existing.channel !== opts.channel ||
            existing.provider !== provider ||
            existing.templateId !== opts.template.id
          ) {
            throw new Error("The existing business reservation does not match the requested dispatch identity")
          }
          rearmCandidate = existing
        } else {
          return {
            message: existing,
            created: false,
            rearmed: false,
            dispatchToken: null,
            ...preparedPayload,
          }
        }
      } else if (opts.rearmDefinitelyRejected) {
        // A replay is authority to re-arm one known, definitely-rejected
        // reservation. It is not authority to create a new occurrence when
        // that reservation cannot be found (for example after a bad legacy
        // log or a changed occurrence key).
        throw new Error("Cannot re-arm: no existing message reservation matches this occurrence")
      }
    }

    const eligibility = await canSendTx(txClient, opts.contactId, opts.channel, opts.template)
    if (!eligibility.ok) {
      throw new SendBlockedError(eligibility.reason)
    }

    if (rearmCandidate) {
      const reason = opts.rearmDefinitelyRejected!.reason.trim()
      if (reason.length < 10 || reason.length > 2_000) {
        throw new Error("A 10-2000 character reason is required to re-arm a definitely rejected message")
      }
      const control = newMessageDispatchControl(
        new Date(),
        rearmCandidate.dispatchAttempt + 1,
      )
      const rearmed = await tx.message.updateMany({
        where: {
          id: rearmCandidate.id,
          tenantId: opts.template.tenantId,
          status: rearmCandidate.status,
          dispatchState: "DEFINITELY_REJECTED",
          dispatchToken: rearmCandidate.dispatchToken,
        },
        data: {
          status: "QUEUED",
          retryCount: 0,
          nextRetryAt: null,
          lastErrorAt: null,
          errorClass: null,
          errorMessage: null,
          lawfulBasis: eligibility.basis,
          basisEvidence: eligibility.evidence,
          consentId: eligibility.consentId ?? null,
          ...control,
        },
      })
      if (rearmed.count !== 1) throw new MessageDispatchConflictError()
      await tx.auditLog.create({
        data: {
          tenantId: opts.template.tenantId,
          userId: opts.rearmDefinitelyRejected!.userId,
          userEmail: opts.rearmDefinitelyRejected!.userEmail,
          action: AuditAction.MESSAGE_DISPATCH_REARMED,
          entity: "Message",
          entityId: rearmCandidate.id,
          oldValue: {
            status: rearmCandidate.status,
            retryCount: rearmCandidate.retryCount,
            dispatchState: rearmCandidate.dispatchState,
            dispatchToken: rearmCandidate.dispatchToken,
            errorClass: rearmCandidate.errorClass,
            errorMessage: rearmCandidate.errorMessage,
          },
          newValue: {
            status: "QUEUED",
            retryCount: 0,
            dispatchState: "DISPATCHING",
            dispatchToken: control.dispatchToken,
            dispatchAttempt: control.dispatchAttempt,
            reason,
            explicitOperatorRearm: true,
            previousOutcome: "DEFINITELY_REJECTED",
          },
        },
      })
      const message = await tx.message.findFirstOrThrow({
        where: { id: rearmCandidate.id, tenantId: opts.template.tenantId },
      })
      return {
        message,
        created: true,
        rearmed: true,
        dispatchToken: control.dispatchToken,
        ...preparePayload(rearmCandidate.createdAt ?? requestPreparedAt),
      }
    }

    const conversationId = await resolveOrCreateConversationTx(txClient, opts)
    // Start the lease immediately before the Message reservation is written.
    // Eligibility checks or advisory-lock waits must not consume an active
    // provider lease before a provider call can even begin.
    const initialControl = newMessageDispatchControl()
    const preparedPayload = preparePayload(requestPreparedAt)

    const message = await tx.message.create({
      data: {
        tenantId: opts.template.tenantId,
        conversationId,
        channel: opts.channel,
        direction: "OUTBOUND",
        provider,
        status: "QUEUED",
        templateId: opts.template.id,
        lawfulBasis: eligibility.basis,
        basisEvidence: eligibility.evidence,
        consentId: eligibility.consentId ?? null,
        subject: stored.subject,
        bodyText: stored.text,
        bodyHtml: stored.html,
        toValue: opts.toValue,
        createdById: opts.createdById ?? null,
        idempotencyKey,
        payloadFingerprint: preparedPayload.payloadFingerprint,
        createdAt: requestPreparedAt,
        ...initialControl,
      },
    })
    return {
      message,
      created: true,
      rearmed: false,
      dispatchToken: initialControl.dispatchToken,
      ...preparedPayload,
    }
  }, { isolationLevel: "Serializable" }))

  const msg = prepared.message
  if (!prepared.created) {
    if (requiresMessageReconciliation(msg)) {
      throw new MessageReconciliationRequiredError(
        msg,
        "This business event is already reserved and requires manual reconciliation",
      )
    }
    const acceptedAt = msg.sentAt ?? msg.dispatchProviderAcceptedAt
    if (["SENT", "DELIVERED", "READ"].includes(msg.status) && acceptedAt) {
      await prisma.conversation.updateMany({
        where: {
          id: msg.conversationId,
          tenantId: opts.template.tenantId,
          OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: acceptedAt } }],
        },
        data: { lastOutboundAt: acceptedAt },
      })
      // Inbox queue sort key — must move with every lastInboundAt/
      // lastOutboundAt write. Guarded independently: acceptedAt is the
      // provider's acceptance time and can predate an inbound that landed
      // since, so an unguarded write would sink the thread in the queue.
      await prisma.conversation.updateMany({
        where: {
          id: msg.conversationId,
          tenantId: opts.template.tenantId,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: acceptedAt } }],
        },
        data: { lastActivityAt: acceptedAt },
      })
    }
    return msg
  }

  // Test doubles created before the dispatch-control migration may omit the
  // new fields. Real rows always carry the committed token.
  const dispatchToken = msg.dispatchToken ?? prepared.dispatchToken
  if (!dispatchToken) {
    throw new Error("Message dispatch reservation is missing its attempt token")
  }

  // A re-arm normally replays the STORED body, so the second attempt is
  // byte-identical to the first. For a redacted template the stored body is a
  // placeholder, so replaying it would deliver the placeholder to the
  // consumer. Re-render instead — safe because the re-arm path only proceeds
  // once `sameRequest` has proved the fresh render fingerprints identically to
  // the original request.
  const dispatchPayload = prepared.rearmed && !opts.template.redactStoredBody
    ? { subject: msg.subject, html: msg.bodyHtml, text: msg.bodyText ?? "" }
    : rendered
  const dispatchToValue = prepared.rearmed ? msg.toValue ?? opts.toValue : opts.toValue

  let waTemplate: WaTemplateRef | undefined = undefined
  if (opts.channel === "WHATSAPP" && provider === "WA_CLOUD" && opts.template.wabaTemplateName) {
    // Stored buttons the CREATE path would refuse mean the approved template and
    // the stored row disagree — send nothing rather than a partial payload.
    const sendButtons = readSendButtons(opts.template.buttons)
    const placeholders = [
      ...extractPlaceholders(opts.template.bodyTemplate ?? ""),
      ...extractPlaceholders(opts.template.headerContent ?? ""),
      // A URL button's variable is just as required as a body one: without it
      // Meta renders the approval-time example url, so every borrower would
      // receive the same link.
      ...extractButtonPlaceholders(opts.template.buttons),
    ]
    // Absent OR blank: a present-but-empty value is not a value. It renders an
    // empty word in a body, and appended to a button url it yields a dead
    // clickable link. Applies to body, header and button variables alike.
    const missingVars = placeholders.filter((n) => (opts.vars[n] ?? "").trim() === "")
    if (!sendButtons.ok) missingVars.push("__buttons__")
    // A template with any unfilled var is NOT usable — never ship a blank field.
    // In-window this falls back to free text; out-of-window the sender returns the
    // typed "pick a template" error rather than a blank message.
    if (missingVars.length === 0) {
      waTemplate = {
        name: opts.template.wabaTemplateName,
        language: opts.template.language,
        providerStatus: opts.template.providerStatus,
        components: buildTemplateComponents(
          {
            bodyTemplate: opts.template.bodyTemplate,
            headerContent: opts.template.headerContent,
            buttons: opts.template.buttons,
          },
          opts.vars,
        ),
      }
    }
  }

  // Dispatch after commit. Failure must not roll back the Message row —
  // we need it in FAILED state for the audit trail and the retry path.
  let dispatchResult: Awaited<ReturnType<typeof dispatchWithinTimeout>>
  try {
    dispatchResult = await dispatchWithinTimeout(opts.channel, provider, dispatchPayload, {
      tenantId: opts.template.tenantId,
      toValue: dispatchToValue,
      toName: opts.toName,
      category: opts.category,
      // Keeps /api/email/logs?referenceId=<id> working for pipeline sends.
      referenceId: opts.applicationId ?? opts.loanId,
      listUnsubscribeUrl: prepared.listUnsubscribeUrl,
      // The provider still receives dispatchPayload (the TRUE body); this
      // only redacts the EmailLog row, which would otherwise hold the secret
      // in plaintext and defeat the Message-level redaction entirely.
      redactedBodyPlaceholder: opts.template.redactStoredBody
        ? REDACTED_BODY_PLACEHOLDER
        : undefined,
      replyTo: opts.replyTo,
      attachments: opts.attachments,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      onProviderDispatchStart: opts.onProviderDispatchStart,
      contactId: opts.contactId,
      waTemplate,
    })
  } catch (err) {
    const failureOutcome = providerFailureOutcome(err)
    const currentRetryCount = msg.retryCount ?? 0
    const klass = classifyError(err, provider)

    if (externallyOwnedDispatch) {
      await closeExternallyOwnedMessageDispatch({
        tenantId: opts.template.tenantId,
        messageId: msg.id,
        dispatchToken,
        providerOutcome: failureOutcome,
        errorClass: klass,
        error: err,
        retryCount: currentRetryCount + 1,
        userId: opts.createdById,
      })
      throw err
    }

    if (failureOutcome === "AMBIGUOUS") {
      try {
        const held = await holdMessageDispatchForReconciliation({
          tenantId: opts.template.tenantId,
          messageId: msg.id,
          dispatchToken,
          state: "AMBIGUOUS",
          reason: err,
          userId: opts.createdById,
          action: "MESSAGE_DISPATCH_FAILED_RECONCILIATION_REQUIRED",
          auditExtra: {
            provider,
            providerOutcome: failureOutcome,
            automaticRetrySuppressed: true,
          },
        })
        throw new MessageReconciliationRequiredError(held)
      } catch (holdError) {
        if (holdError instanceof MessageReconciliationRequiredError) throw holdError
        throw new MessageReconciliationRequiredError(
          msg,
          "Provider outcome is ambiguous and the reconciliation hold could not be confirmed; do not retry",
        )
      }
    }
    const nextBackoffMs = automaticRetry && klass === "TRANSIENT"
      ? backoff(currentRetryCount)
      : null
    const permanent = !automaticRetry || klass === "PERMANENT" || nextBackoffMs === null
    return failMessageDispatchDefinitely({
      tenantId: opts.template.tenantId,
      messageId: msg.id,
      dispatchToken,
      status: permanent ? "FAILED_PERMANENT" : "RETRYING",
      retryCount: currentRetryCount + 1,
      nextRetryAt: permanent ? null : new Date(Date.now() + nextBackoffMs!),
      errorClass: permanent && !automaticRetry && klass === "TRANSIENT"
        ? "TRANSIENT_NO_AUTOMATIC_RETRY"
        : permanent
          ? klass
          : "TRANSIENT",
      error: err,
      userId: opts.createdById,
      auditExtra: { provider, providerOutcome: failureOutcome },
    })
  }

  let firstWriteError: unknown
  let simulated: boolean
  let providerMessageId: string | undefined
  let providerAcceptedAt: Date | undefined
  let evidenceReference: string | undefined
  // Which WhatsApp number actually carried this message — the bridge pool
  // fails over on its own, so this is the only per-message record of it.
  let fromValue: string | undefined
  let simulationReceiptId: string | undefined
  const auxiliaryPersistenceError = dispatchResult.simulated === true
    ? undefined
    : dispatchResult.auxiliaryPersistenceError
  if (dispatchResult.simulated === true) {
    simulated = true
    simulationReceiptId = dispatchResult.simulationReceiptId
  } else {
    simulated = false
    providerMessageId = dispatchResult.providerMessageId
    providerAcceptedAt = dispatchResult.acceptedAt
    evidenceReference = dispatchResult.evidenceReference
    fromValue = dispatchResult.fromValue
  }
  try {
    return await completeMessageDispatch({
      tenantId: opts.template.tenantId,
      messageId: msg.id,
      dispatchToken,
      providerMessageId,
      providerAcceptedAt,
      evidenceReference,
      fromValue,
      simulationReceiptId,
      simulated,
      userId: opts.createdById,
      auditExtra: { provider, auxiliaryPersistenceError },
    })
  } catch (error) {
    firstWriteError = error
  }

  try {
    return await completeMessageDispatch({
      tenantId: opts.template.tenantId,
      messageId: msg.id,
      dispatchToken,
      providerMessageId,
      providerAcceptedAt,
      evidenceReference,
      fromValue,
      simulationReceiptId,
      simulated,
      userId: opts.createdById,
      auditExtra: { provider, postDispatchRecovery: true, auxiliaryPersistenceError },
    })
  } catch (recoveryWriteError) {
    try {
      const held = await holdMessageDispatchForReconciliation({
        tenantId: opts.template.tenantId,
        messageId: msg.id,
        dispatchToken,
        state: simulated ? "SIMULATED" : "ACCEPTED",
        reason: recoveryWriteError,
        providerMessageId,
        providerAcceptedAt,
        evidenceReference,
        simulationReceiptId,
        userId: opts.createdById,
        action: simulated
          ? "MESSAGE_SIMULATED_DB_WRITE_FAILED"
          : "MESSAGE_SENT_DB_WRITE_FAILED",
        auditExtra: {
          provider,
          firstWriteError: String(firstWriteError),
          auxiliaryPersistenceError,
        },
      })
      throw new MessageReconciliationRequiredError(held)
    } catch (holdError) {
      if (holdError instanceof MessageReconciliationRequiredError) throw holdError
      let evidenceAuditWriteError: unknown
      try {
        await prisma.auditLog.create({
          data: {
            tenantId: opts.template.tenantId,
            userId: opts.createdById ?? null,
            userEmail: null,
            action: AuditAction.MESSAGE_DISPATCH_EVIDENCE_RECOVERED,
            entity: "Message",
            entityId: msg.id,
            oldValue: {
              status: msg.status,
              dispatchState: msg.dispatchState ?? null,
              dispatchToken,
            },
            newValue: {
              outcome: simulated ? "SIMULATED" : "PROVIDER_ACCEPTED",
              provider,
              providerMessageId: providerMessageId ?? null,
              providerAcceptedAt: providerAcceptedAt?.toISOString() ?? null,
              evidenceReference: evidenceReference ?? null,
              simulationReceiptId: simulationReceiptId ?? null,
              auxiliaryPersistenceError: auxiliaryPersistenceError ?? null,
              terminalWriteError: String(firstWriteError),
              recoveryWriteError: String(recoveryWriteError),
              holdWriteError: String(holdError),
              automaticReplayDisabled: true,
            },
          },
        })
      } catch (auditError) {
        evidenceAuditWriteError = auditError
      }
      throw new KnownDispatchPersistenceError({
        outcome: simulated ? "SIMULATED" : "PROVIDER_ACCEPTED",
        message: msg,
        providerMessageId,
        providerAcceptedAt,
        evidenceReference,
        simulationReceiptId,
        firstWriteError,
        recoveryWriteError,
        holdWriteError: holdError,
        evidenceAuditWriteError,
      })
    }
  }
}
