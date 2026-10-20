import type { Channel, MessageTemplate, Provider } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/whatsapp/send-mode"
import { SMS_CHANNEL_OFF_REASON } from "./sms-channel"
import { contactDunningHold, loanDunningHold } from "@/lib/collections/client-holds"
import { NOTICE_LOAN_STATUSES, REMINDABLE_LOAN_STATUS } from "@/lib/collections/dunning-holds"
import { automatedDunningLoan, type AutomatedDunningLoan } from "@/lib/messaging/dunning-category"
import { dunningRetryVerdict, nextDunningWindowStart } from "@/lib/messaging/dunning-window"

export type ErrorClass = "TRANSIENT" | "PERMANENT" | "CONSENT_REVOKED" | "EXPIRED"

const BACKOFF_MS: readonly number[] = [
  60_000,         // retryCount 0 → 1m
  300_000,        // retryCount 1 → 5m
  1_800_000,      // retryCount 2 → 30m
  7_200_000,      // retryCount 3 → 2h
  43_200_000,     // retryCount 4 → 12h
]

export const MAX_RETRY_ATTEMPTS = BACKOFF_MS.length // 5
export const RETRY_AGE_LIMIT_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * Returns the milliseconds to wait before the next retry attempt for a row
 * that has failed `retryCount` times. Returns null when retries are exhausted
 * (caller should transition to FAILED_PERMANENT).
 */
export function backoff(retryCount: number): number | null {
  if (retryCount < 0 || retryCount >= BACKOFF_MS.length) return null
  return BACKOFF_MS[retryCount]
}

/**
 * Per-provider error classification. Default: TRANSIENT (over-retry rather
 * than silently drop). Per-provider 4xx signatures captured here are based
 * on observed failures + each provider's documented permanent errors.
 *
 * EXPIRED is NOT returned here — it's an age-based decision the cron sweep
 * makes by inspecting message.createdAt. classifyError only looks at the
 * error message.
 */
export function classifyError(err: unknown, provider: Provider): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()

  // Permanent failures — provider rejected the request, retrying won't help
  switch (provider) {
    case "RESEND":
    case "MSGRAPH":
    case "SMTP": {
      if (/\b422\b|invalid_to_address|invalid_recipient/i.test(msg)) return "PERMANENT"
      if (/\b400\b.*(template_rejected|invalid_template)/i.test(msg)) return "PERMANENT"
      if (/\b429\b.*(quota_exceeded|over_quota|out_of_budget)/i.test(msg)) return "PERMANENT"
      // Tenant email is unconfigured or partially configured (lib/email/
      // service.ts: "Email not configured for this tenant", "MS Graph config
      // incomplete", "SMTP config incomplete") — config gaps that won't change
      // between cron ticks, so retrying just burns the budget. Same rationale
      // as the WA "disabled" rule below.
      if (/email not configured for this tenant|(?:ms graph|smtp) config incomplete/i.test(msg)) return "PERMANENT"
      break
    }
    case "BULKSMS": {
      // BulkSMS error bodies surface a numeric code; capture the common
      // permanent ones (1000=invalid sender, 1001=invalid number,
      // 1002=blacklisted recipient).
      if (/code["':\s]+10(00|01|02)/i.test(msg)) return "PERMANENT"
      // No BulkSMS credentials configured (lib/integrations/bulksms.ts) —
      // config gap, retry never helps. Same rationale as the WA rule below.
      if (/bulksms not configured/i.test(msg)) return "PERMANENT"
      // The SMS channel is switched off (BULKSMS_DRY_RUN — sendSms returns
      // SMS_CHANNEL_OFF_REASON without touching the provider). The env var
      // will not change between cron ticks, so retrying just accrues
      // RETRYING rows for a channel nobody is listening on. Exactly the
      // rationale as the WA "disabled" rule below.
      if (lower.includes(SMS_CHANNEL_OFF_REASON.toLowerCase())) return "PERMANENT"
      break
    }
    case "WA_UNOFFICIAL":
    case "WA_CLOUD":
    case "WA_BSP_360DIALOG": {
      // Outside the 24h WhatsApp service window without an approved template
      // (lib/whatsapp/send-mode.ts). Meta rejects the exact same free-form
      // send every time, so retrying is pointless — classify PERMANENT so
      // lib/inbox/dispatch.ts's OUTSIDE_WINDOW mapping is reachable instead
      // of the message sitting RETRYING through 5 doomed cron attempts.
      if (msg.includes(WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE)) return "PERMANENT"
      if (/\b401\b|invalid token|unauthor/i.test(msg)) return "PERMANENT"
      if (/\b403\b/i.test(msg)) return "PERMANENT"
      if (/invalid phone|invalid_msisdn/i.test(msg)) return "PERMANENT"
      // WA_ENABLED=false on the environment — sendWhatsAppMessage returns
      // "WhatsApp disabled". Retrying won't help (the env var isn't going
      // to change between cron ticks); without this, an env without WA
      // would accrue endless RETRYING rows for every reminder.
      if (/whatsapp\s+disabled/i.test(msg)) return "PERMANENT"
      break
    }
  }

  // Transient — network, timeout, 5xx
  if (
    lower.includes("etimedout") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("timeout") ||
    /\b5\d\d\b/.test(msg) ||
    lower.includes("network") ||
    lower.includes("fetch failed")
  ) {
    return "TRANSIENT"
  }

  // Default: TRANSIENT. Over-retry > silently drop.
  return "TRANSIENT"
}

import { prisma } from "@/lib/prisma"
import { canSendTx, resolveProvider } from "./send"
import { providerFailureOutcome } from "./providers"
import { logAudit } from "@/lib/audit"
import { stringifyError } from "./errors"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { dispatchWithinTimeout } from "./provider-timeout"
import {
  completeMessageDispatch,
  failMessageDispatchDefinitely,
  holdMessageDispatchForReconciliation,
  newMessageDispatchControl,
  updateLinkedNotificationProjection,
} from "./dispatch-control"

export type ProcessResult = {
  scanned: number
  expired: number
  suppressed: number
  dispatched: number
  simulated: number
  manualReconciliation: number
  rescheduled: number
  failedPermanent: number
}

/**
 * Cron sweep work unit. Bulk-expires stale rows, then per-row re-evaluates
 * eligibility + re-dispatches. A durable, independently committed no-replay
 * claim is written before every provider call so an outer sweep rollback
 * cannot make a provider-accepted message eligible for dispatch again.
 *
 * Runs in admin scope (`withoutTenantScope`) because the sweep is
 * intentionally cross-tenant — RETRYING rows live across every tenant and
 * the auto-tenant-injection middleware would otherwise refuse the
 * cross-tenant `Message.updateMany` / `findMany` / `update` calls below.
 * Per-row writes still carry the row's own `msg.tenantId` via the audit
 * payload, so tenant attribution is preserved in the audit trail.
 */
// Stable lock key for the messaging-retry sweep. Used with
// `pg_try_advisory_xact_lock(hashtext(SWEEP_LOCK_KEY))` to serialize
// concurrent sweep runs — two cron triggers in the same tick (manual +
// scheduled, or race between two cron hosts) would otherwise grab
// overlapping batches and race per-row updates, surfacing as spurious
// "record not found" errors → catastrophic-catch → false FAILED_PERMANENT
// terminations.
//
// Transaction-scoped (the `_xact_` variant) so the lock is auto-released
// on commit OR rollback — no separate unlock query, no risk of leaking the
// lock if a connection drops mid-sweep. The whole sweep body runs inside
// `prisma.$transaction(async (tx) => ...)` so lock, expiry, selection, and
// pre-claim eligibility reads share ONE backend connection. The no-replay
// claim and its terminal/failure finalisation intentionally use the global
// client: those writes must commit independently and survive a rollback of
// this advisory-lock transaction after a provider call.
const SWEEP_LOCK_KEY = "messaging-retry-sweep"
// 5 minutes — generous ceiling for a normal sweep + dispatch round-trips.
// If a sweep ever exceeds this, the tx aborts (and the lock auto-releases),
// the affected rows stay RETRYING for the next tick.
const SWEEP_TX_TIMEOUT_MS = 5 * 60 * 1000

// The generic retry worker persists only rendered subject/body. It cannot
// reconstruct statutory artifacts, immutable workflow reservations, or the
// provider-evidence finalisation owned by the originating workflow. Treat
// every statutory-override template as non-replayable: today that includes
// section129_email, and the fail-closed rule also protects any later
// statutory workflow from accidentally entering this body-only retry path.
const NON_REPLAYABLE_RETRY_ERROR_CLASS = "STATUTORY_MANUAL_RECONCILIATION"
// A `redactStoredBody` template stores a PLACEHOLDER in bodyText/bodyHtml, so
// the body-only rebuild below would dispatch "[redacted — ...]" to the
// consumer instead of their one-time code or signing link. The vars needed to
// re-render are not persisted, so this is not recoverable here — fail closed
// and let the owning workflow mint a fresh send. Symmetric with the statutory
// guard above, and explicit rather than relying on the fact that every current
// redacted callsite happens to pass automaticRetry:false.
const NON_REPLAYABLE_REDACTED_ERROR_CLASS = "REDACTED_BODY_NOT_REPLAYABLE"
const NON_REPLAYABLE_EMAIL_ERROR_CLASS = "EMAIL_PAYLOAD_NOT_RECONSTRUCTABLE"

type RetryTenantIntegrityRelation = "template" | "conversation" | "contact"

class RetryTenantIntegrityError extends Error {
  readonly relation: RetryTenantIntegrityRelation

  constructor(relation: RetryTenantIntegrityRelation) {
    super(`Retry ${relation} is missing or belongs to another tenant`)
    this.name = "RetryTenantIntegrityError"
    this.relation = relation
  }
}

function isPrismaNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025"
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

type RetryClaimArgs = {
  id: string
  tenantId: string
  retryCount: number
  provider: Provider
  eligibleAt: Date
}

/**
 * Commit the no-replay claim before crossing the provider boundary.
 *
 * The exported wrapper deliberately opens an independent transaction even
 * when called from the retry sweep's advisory-lock transaction. The same
 * primitive is used inside the separate eligibility transaction below. In
 * both cases the claim must survive a rollback or connection loss in the outer
 * sweep after a provider accepts the message. QUEUED is not selected by the
 * retry sweep; the specific errorClass distinguishes this reconciliation hold
 * from an ordinary new send.
 */
async function claimRetryDispatchTx(
  tx: TxClient,
  args: RetryClaimArgs,
): Promise<string | null> {
  // The sweep timestamp proves this row was eligible when selected; it must
  // never anchor a new provider lease. A large batch can spend minutes on
  // earlier rows, so create the attempt from a fresh clock inside the exact
  // transaction that commits the claim.
  const control = newMessageDispatchControl(new Date(), args.retryCount + 1)
  const claimed = await tx.message.updateMany({
    where: {
      id: args.id,
      tenantId: args.tenantId,
      status: "RETRYING",
      retryCount: args.retryCount,
      nextRetryAt: { lte: args.eligibleAt },
    },
    data: {
      status: "QUEUED",
      nextRetryAt: null,
      errorClass: null,
      errorMessage: null,
      ...control,
    },
  })
  if (claimed.count !== 1) return null

  await updateLinkedNotificationProjection(tx, {
    tenantId: args.tenantId,
    messageId: args.id,
    status: "pending",
    error: null,
  })

  await tx.auditLog.create({
    data: {
      tenantId: args.tenantId,
      action: "MESSAGE_RETRY_DISPATCH_CLAIMED",
      entity: "Message",
      entityId: args.id,
      oldValue: {
        status: "RETRYING",
        retryCount: args.retryCount,
      },
      newValue: {
        provider: args.provider,
        status: "QUEUED",
        dispatchState: "DISPATCHING",
        dispatchToken: control.dispatchToken,
        dispatchLeaseExpiresAt: control.dispatchLeaseExpiresAt.toISOString(),
        retryCount: args.retryCount,
        automaticReplayDisabled: true,
        viaRetryCron: true,
      },
    },
  })
  return control.dispatchToken
}

export async function claimRetryDispatch(args: RetryClaimArgs): Promise<string | null> {
  return prisma.$transaction((tx) => claimRetryDispatchTx(tx, args))
}

type RetryEligibilityClaim =
  | { kind: "claimed"; dispatchToken: string }
  | { kind: "suppressed"; reason: string }
  | { kind: "stale" }

/**
 * Re-check consent and reserve one provider attempt in one short transaction.
 * canSendTx's Contact/ContactConsent row locks are therefore released as soon
 * as this row is claimed (or suppressed), before the provider call and before
 * any unrelated batch row is processed. A STOP/unsubscribe writer can never
 * be held behind a multi-minute retry sweep.
 */
async function claimRetryDispatchIfEligible(args: RetryClaimArgs & {
  contactId: string
  channel: Channel
  template: MessageTemplate
  checkedAt: Date
  /** Message.dunning: only a reminder or overdue notice is held for a client hold. */
  dunning: boolean
  /** The loan an automated dunning message is about (lib/messaging/dunning-category.ts), checked inside this transaction. */
  dunningLoan: AutomatedDunningLoan | null
  /** When the message was queued: a pre-due reminder is judged against the day it was queued for. */
  createdAt: Date
}): Promise<RetryEligibilityClaim> {
  return prisma.$transaction(async (eligibilityTx) => {
    const eligibility = await canSendTx(
      eligibilityTx as Parameters<typeof canSendTx>[0],
      args.contactId,
      args.channel,
      args.template,
    )

    // A death or a debt-review notice recorded since the message was queued holds
    // DUNNING only (Message.dunning): the borrower is still owed statements,
    // receipts and transactional messages, and a deceased client's other
    // messages are already stopped by the Contact block inside canSendTx.
    const hold = eligibility.ok && args.dunning
      ? await contactDunningHold(eligibilityTx as Parameters<typeof contactDunningHold>[0], {
        tenantId: args.tenantId,
        contactId: args.contactId,
      })
      : null

    // The loan's status and its holds, in this same transaction: a reminder goes only to an ACTIVE loan, a
    // notice (the 60-DPD one) also to a DEFAULTED one.
    const loanHold = eligibility.ok && !hold && args.dunning && args.dunningLoan
      ? await loanDunningHold(eligibilityTx as Parameters<typeof loanDunningHold>[0], {
        tenantId: args.tenantId,
        loanId: args.dunningLoan.loanId,
        statuses: args.dunningLoan.notice ? NOTICE_LOAN_STATUSES : [REMINDABLE_LOAN_STATUS],
        // A reminder (not a notice) also stops when the borrower has since paid.
        ...(args.dunningLoan.notice ? {} : { reminder: { overdue: args.dunningLoan.overdue, asOf: new Date(), occurrence: args.dunningLoan.occurrence, createdAt: args.createdAt } }),
      })
      : null

    if (!eligibility.ok || hold || loanHold) {
      // No MsgStatus says "held": SUPPRESSED_BY_CONSENT is the nearest terminal,
      // never-retried outcome, so the text and the audit row name the real cause.
      const reason = !eligibility.ok
        ? eligibility.reason
        : hold
          ? `client hold: ${hold.kind === "DECEASED" ? "deceased" : "debt review"}: ${hold.reason}`
          : `loan hold: ${loanHold}`
      const errorMessage = `canSendTx rejected on retry: ${reason}`
      const transitioned = await eligibilityTx.message.updateMany({
        where: {
          id: args.id,
          tenantId: args.tenantId,
          status: "RETRYING",
          retryCount: args.retryCount,
        },
        data: {
          status: "SUPPRESSED_BY_CONSENT",
          errorClass: "CONSENT_REVOKED",
          errorMessage,
          lastErrorAt: args.checkedAt,
        },
      })
      if (transitioned.count !== 1) return { kind: "stale" }

      await updateLinkedNotificationProjection(eligibilityTx, {
        tenantId: args.tenantId,
        messageId: args.id,
        status: "suppressed_by_consent",
        error: errorMessage,
      })
      await eligibilityTx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          action: "MESSAGE_SUPPRESSED_BY_CONSENT",
          entity: "Message",
          entityId: args.id,
          newValue: { reason, retryCount: args.retryCount, ...(hold ? { clientHold: hold.kind } : {}), ...(loanHold ? { loanHold: true } : {}) },
        },
      })
      return { kind: "suppressed", reason }
    }

    const dispatchToken = await claimRetryDispatchTx(eligibilityTx, args)
    return dispatchToken
      ? { kind: "claimed", dispatchToken }
      : { kind: "stale" }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

const EMPTY_RESULT: ProcessResult = {
  scanned: 0,
  expired: 0,
  suppressed: 0,
  dispatched: 0,
  simulated: 0,
  manualReconciliation: 0,
  rescheduled: 0,
  failedPermanent: 0,
}

export async function processRetryBatch(opts: {
  limit: number
  now: Date
}): Promise<ProcessResult> {
  return withoutTenantScope(() => processRetryBatchInner(opts))
}

async function processRetryBatchInner(opts: {
  limit: number
  now: Date
}): Promise<ProcessResult> {
  return prisma.$transaction(async (tx) => {
    const lockResult = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK_KEY})) AS acquired
    `
    const acquired = lockResult[0]?.acquired === true
    if (!acquired) {
      // Another sweep is in flight. Bail with zero counts so the cron
      // caller can log and the next tick retries. console.warn so cron
      // output captures one line per skipped tick — silent skips would
      // mask a leaked lock as "everything fine, just no work".
      console.warn("[messaging-retry] sweep skipped: pg_try_advisory_xact_lock busy")
      return EMPTY_RESULT
    }
    return processRetryBatchLocked(opts, tx)
  }, { timeout: SWEEP_TX_TIMEOUT_MS })
}

// Pre-claim reads and ordinary no-dispatch transitions go through `tx` so
// they remain governed by the advisory sweep lock. Eligibility + claim use a
// separate, short transaction so Contact/ContactConsent locks never span the
// batch or a provider call. Finalisation also uses independently committed,
// tenant- and claim-scoped predicates so provider outcomes cannot be replayed
// when the outer sweep transaction rolls back.

async function processRetryBatchLocked(opts: {
  limit: number
  now: Date
}, tx: TxClient): Promise<ProcessResult> {
  const { limit, now } = opts
  const ageLimit = new Date(now.getTime() - RETRY_AGE_LIMIT_MS)

  // Bulk-expire — single SQL UPDATE, no per-row processing. Not dunning: that is expired per row below,
  // by the day it was created (lib/messaging/dunning-window.ts), because a blanket 24 hours would drop a
  // message queued mid-morning before the next morning's window opens.
  const expiredResult = await tx.message.updateMany({
    where: {
      status: "RETRYING",
      dunning: false,
      createdAt: { lt: ageLimit },
    },
    data: { status: "EXPIRED", errorClass: "EXPIRED" },
  })
  await tx.notificationLog.updateMany({
    where: {
      messageId: { not: null },
      message: { status: "EXPIRED" },
    },
    data: {
      status: "expired",
      error: "Message retry window expired",
    },
  })

  // Summary audit so ops can correlate large expirations with provider
  // outages. Per-row EXPIRED status is already on the Message row; this
  // audit captures the SWEEP itself (which run produced N expirations).
  // Skipped when count=0 to avoid noise on quiet ticks.
  if (expiredResult.count > 0) {
    await logAudit({
      action: "MESSAGE_EXPIRED_SWEEP",
      entity: "Message",
      // entityId is null — this is a sweep-level audit, not row-level.
      newValue: { count: expiredResult.count, ageLimit, now },
    })
  }

  // Pull next batch. We don't acquire a row lock here — the per-row update
  // is the serialisation point and is idempotent (RETRYING → anything else
  // is a one-way transition for this row's current state).
  const rows = await tx.message.findMany({
    where: {
      status: "RETRYING",
      nextRetryAt: { lte: now },
    },
    orderBy: { nextRetryAt: "asc" },
    take: limit,
  })

  let suppressed = 0
  let dispatched = 0
  let simulated = 0
  let manualReconciliation = 0
  let rescheduled = 0
  let failedPermanent = 0
  let expiredDunning = 0
  const sweepStartedAt = Date.now()

  for (const msg of rows) {
    let claimedDispatchToken: string | null = null
    let tenantIntegrityLookup: RetryTenantIntegrityRelation | null = null
    try {
      if (msg.channel === "EMAIL") {
        const transitioned = await tx.message.updateMany({
          where: {
            id: msg.id,
            tenantId: msg.tenantId,
            status: "RETRYING",
            retryCount: msg.retryCount,
          },
          data: {
            status: "FAILED_PERMANENT",
            nextRetryAt: null,
            errorClass: NON_REPLAYABLE_EMAIL_ERROR_CLASS,
            errorMessage:
              "Automatic email retry suppressed because attachments and headers are not durably reconstructable. Replay the exact fingerprinted request from its owning workflow.",
            lastErrorAt: now,
          },
        })
        if (transitioned.count === 1) {
          await updateLinkedNotificationProjection(tx, {
            tenantId: msg.tenantId,
            messageId: msg.id,
            status: "failed",
            error:
              "Automatic email retry suppressed because attachments and headers are not durably reconstructable. Replay the exact fingerprinted request from its owning workflow.",
          })
          await tx.auditLog.create({
            data: {
              tenantId: msg.tenantId,
              action: "MESSAGE_RETRY_SUPPRESSED_NON_RECONSTRUCTABLE_PAYLOAD",
              entity: "Message",
              entityId: msg.id,
              oldValue: { status: "RETRYING", retryCount: msg.retryCount },
              newValue: {
                status: "FAILED_PERMANENT",
                errorClass: NON_REPLAYABLE_EMAIL_ERROR_CLASS,
                payloadFingerprint: msg.payloadFingerprint,
                automaticReplayDisabled: true,
                providerDispatchStarted: false,
                viaRetryCron: true,
              },
            },
          })
          failedPermanent++
        }
        continue
      }

      // Dunning goes out 07:00-20:00 SAST. Outside the window it waits: rescheduled to the next 07:00 so
      // it stops heading every batch (oldest nextRetryAt first, `take: limit`). An automated reminder not
      // sent by the end of its day expires rather than say "due TOMORROW" a day late; a staff reminder
      // and a 60-DPD notice do not. Judged at the moment of THIS send (the sweep's clock plus the time
      // it has been running), not the moment the sweep started.
      if (msg.dunning) {
        const sendNow = new Date(now.getTime() + (Date.now() - sweepStartedAt))
        const dunningKind = automatedDunningLoan(msg.idempotencyKey)
        const verdict = dunningRetryVerdict(msg.createdAt, sendNow, dunningKind !== null && !dunningKind.notice)
        if (verdict === "wait") {
          // Guarded on status and retryCount: a concurrent change to the row is not overwritten.
          await tx.message.updateMany({
            where: { id: msg.id, tenantId: msg.tenantId, status: "RETRYING", retryCount: msg.retryCount },
            data: { nextRetryAt: nextDunningWindowStart(sendNow) },
          })
          continue
        }
        if (verdict === "expire") {
          const expiredNow = await tx.message.updateMany({
            where: { id: msg.id, tenantId: msg.tenantId, status: "RETRYING", retryCount: msg.retryCount },
            data: {
              status: "EXPIRED",
              nextRetryAt: null,
              errorClass: "EXPIRED",
              errorMessage: "A dunning message not sent by the end of its day is not sent: its wording is dated",
              lastErrorAt: now,
            },
          })
          if (expiredNow.count === 1) {
            await updateLinkedNotificationProjection(tx, {
              tenantId: msg.tenantId,
              messageId: msg.id,
              status: "expired",
              error: "Dunning message not sent by the end of its day",
            })
            expiredDunning++
          }
          continue
        }
      }

      if (!msg.templateId) throw new RetryTenantIntegrityError("template")
      tenantIntegrityLookup = "template"
      const template = await tx.messageTemplate.findUniqueOrThrow({
        where: { id: msg.templateId, tenantId: msg.tenantId },
      })
      if (template.tenantId !== msg.tenantId) {
        throw new RetryTenantIntegrityError("template")
      }
      tenantIntegrityLookup = null

      const redactedBody = template.redactStoredBody === true
      if (
        msg.lawfulBasis === "STATUTORY_OVERRIDE"
        || template.statutoryOverride === true
        || redactedBody
      ) {
        const errorClass = redactedBody
          ? NON_REPLAYABLE_REDACTED_ERROR_CLASS
          : NON_REPLAYABLE_RETRY_ERROR_CLASS
        const errorMessage = redactedBody
          ? "Automatic retry suppressed: this template's stored body is redacted, so replaying it would deliver the placeholder instead of the real one-time code or link. Re-send through the owning workflow."
          : "Automatic retry suppressed for a non-replayable statutory message. Verify the provider outcome and reconcile through the owning workflow."
        const transitioned = await tx.message.updateMany({
          where: {
            id: msg.id,
            tenantId: msg.tenantId,
            status: "RETRYING",
            retryCount: msg.retryCount,
          },
          data: {
            status: "FAILED_PERMANENT",
            nextRetryAt: null,
            errorClass,
            errorMessage,
            lastErrorAt: now,
          },
        })
        if (transitioned.count !== 1) continue
        await updateLinkedNotificationProjection(tx, {
          tenantId: msg.tenantId,
          messageId: msg.id,
          status: "failed",
          error: errorMessage,
        })
        await logAudit({
          tenantId: msg.tenantId,
          action: "MESSAGE_RETRY_SUPPRESSED_NON_REPLAYABLE",
          entity: "Message",
          entityId: msg.id,
          newValue: {
            templateId: template.id,
            templateKey: template.key,
            errorClass,
            retryCount: msg.retryCount,
            viaRetryCron: true,
            manualReconciliationRequired: true,
          },
        })
        failedPermanent++
        continue
      }

      // Fetch contactId from the Conversation — Message has no direct contactId column.
      tenantIntegrityLookup = "conversation"
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: msg.conversationId, tenantId: msg.tenantId },
        select: { contactId: true, tenantId: true },
      })
      if (conversation.tenantId !== undefined && conversation.tenantId !== msg.tenantId) {
        throw new RetryTenantIntegrityError("conversation")
      }
      tenantIntegrityLookup = "contact"
      const contact = await tx.contact.findUniqueOrThrow({
        where: { id: conversation.contactId, tenantId: msg.tenantId },
        select: { id: true, tenantId: true },
      })
      if (contact.tenantId !== undefined && contact.tenantId !== msg.tenantId) {
        throw new RetryTenantIntegrityError("contact")
      }
      tenantIntegrityLookup = null

      // Re-dispatch using the already-rendered body — vars are not persisted
      // on Message, so we cannot re-render from scratch. The persisted
      // bodyText/bodyHtml/subject IS the rendered output.
      const provider = await resolveProvider(msg.channel, msg.tenantId)
      const rendered = {
        subject: msg.subject ?? null,
        html: msg.bodyHtml ?? null,
        text: msg.bodyText ?? "",
      }

      // Dunning queued by the crons stops when its loan is no longer dunnable or went on hold
      // since (the client holds cover a death and a debt review only); the check runs in the
      // eligibility transaction below.
      const dunningLoan = msg.dunning ? automatedDunningLoan(msg.idempotencyKey) : null

      const claim = await claimRetryDispatchIfEligible({
        id: msg.id,
        tenantId: msg.tenantId,
        retryCount: msg.retryCount,
        provider,
        eligibleAt: now,
        checkedAt: now,
        contactId: conversation.contactId,
        channel: msg.channel,
        template,
        dunning: msg.dunning,
        dunningLoan,
        createdAt: msg.createdAt,
      })
      if (claim.kind === "suppressed") {
        suppressed++
        continue
      }
      if (claim.kind === "stale") continue
      const dispatchToken = claim.dispatchToken
      claimedDispatchToken = dispatchToken

      let dispatchResult: Awaited<ReturnType<typeof dispatchWithinTimeout>>
      try {
        dispatchResult = await dispatchWithinTimeout(msg.channel, provider, rendered, {
          tenantId: msg.tenantId,
          toValue: msg.toValue ?? "",
          // WA_CLOUD reads the 24h service window off this contact and has no
          // other source. Omitting it makes every retry look out-of-window —
          // even a reply to someone who messaged a minute ago — and the
          // resulting WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE classifies PERMANENT,
          // so a transient blip became a dead message. Tenant-validated above.
          // No waTemplate: vars are not persisted (see the render note above),
          // so an out-of-window retry cannot rebuild the template payload and
          // is correctly rejected rather than sent with guessed variables.
          contactId: conversation.contactId,
        })
      } catch (err) {
        const providerOutcome = providerFailureOutcome(err)
        if (providerOutcome === "AMBIGUOUS") {
          manualReconciliation++
          await holdMessageDispatchForReconciliation({
            tenantId: msg.tenantId,
            messageId: msg.id,
            dispatchToken,
            state: "AMBIGUOUS",
            reason: err,
            action: "MESSAGE_RETRY_DISPATCH_RECONCILIATION_REQUIRED",
            auditExtra: {
              provider,
              providerOutcome,
              automaticReplayDisabled: true,
              viaRetryCron: true,
            },
          })
          continue
        }
        const klass = classifyError(err, provider)
        // Let backoff()'s null return drive exhaustion (backoff(5) → null per spec).
        const nextBackoffMs = klass === "TRANSIENT" ? backoff(msg.retryCount) : null
        const failedAt = new Date()

        const permanent = klass === "PERMANENT" || nextBackoffMs === null
        await failMessageDispatchDefinitely({
          tenantId: msg.tenantId,
          messageId: msg.id,
          dispatchToken,
          status: permanent ? "FAILED_PERMANENT" : "RETRYING",
          retryCount: msg.retryCount + 1,
          nextRetryAt: permanent ? null : new Date(failedAt.getTime() + nextBackoffMs!),
          errorClass: permanent ? klass : "TRANSIENT",
          error: err,
          auditExtra: { provider, providerOutcome, viaRetryCron: true },
        })
        if (permanent) failedPermanent++
        else rescheduled++
        continue
      }

      // Provider completion and operator reconciliation share the same token
      // and state CAS. A late sender can therefore never overwrite an audited
      // operator resolution.
      let firstPersistenceError: unknown
      let terminalMessage: Awaited<ReturnType<typeof completeMessageDispatch>> | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          terminalMessage = await completeMessageDispatch({
            tenantId: msg.tenantId,
            messageId: msg.id,
            dispatchToken,
            providerMessageId: dispatchResult.simulated ? undefined : dispatchResult.providerMessageId,
            providerAcceptedAt: dispatchResult.simulated ? undefined : dispatchResult.acceptedAt,
            evidenceReference: dispatchResult.simulated ? undefined : dispatchResult.evidenceReference,
            simulationReceiptId: dispatchResult.simulated ? dispatchResult.simulationReceiptId : undefined,
            simulated: dispatchResult.simulated === true,
            auditExtra: {
              provider,
              retryCount: msg.retryCount,
              viaRetryCron: true,
              ...(attempt === 2 ? { postDispatchRecovery: true } : {}),
            },
          })
          break
        } catch (persistenceError) {
          if (attempt === 1) firstPersistenceError = persistenceError
        }
      }
      if (terminalMessage) {
        if (dispatchResult.simulated) simulated++
        else dispatched++
        continue
      }

      manualReconciliation++
      await holdMessageDispatchForReconciliation({
        tenantId: msg.tenantId,
        messageId: msg.id,
        dispatchToken,
        state: dispatchResult.simulated ? "SIMULATED" : "ACCEPTED",
        reason: firstPersistenceError,
        providerMessageId: dispatchResult.simulated ? undefined : dispatchResult.providerMessageId,
        providerAcceptedAt: dispatchResult.simulated ? undefined : dispatchResult.acceptedAt,
        evidenceReference: dispatchResult.simulated ? undefined : dispatchResult.evidenceReference,
        simulationReceiptId: dispatchResult.simulated ? dispatchResult.simulationReceiptId : undefined,
        action: dispatchResult.simulated
          ? "MESSAGE_SIMULATED_DB_WRITE_FAILED"
          : "MESSAGE_SENT_DB_WRITE_FAILED",
        auditExtra: {
          provider,
          automaticReplayDisabled: true,
          viaRetryCron: true,
        },
      })
    } catch (innerErr) {
      if (claimedDispatchToken) {
        // Once the durable attempt token exists, this outer sweep must never
        // write a status from its stale pre-claim snapshot. The attempt remains
        // DISPATCHING until its bounded lease expires (or a nested transition
        // already resolved it), after which the operator queue can reconcile it.
        manualReconciliation++
        console.error(
          `[messaging-retry] claimed attempt ${claimedDispatchToken} for ${msg.id} could not be finalised; automatic replay remains blocked`,
          innerErr,
        )
        await logAudit({
          tenantId: msg.tenantId,
          action: "MESSAGE_RETRY_ATTEMPT_FINALISATION_FAILED",
          entity: "Message",
          entityId: msg.id,
          newValue: {
            dispatchToken: claimedDispatchToken,
            error: stringifyError(innerErr),
            automaticReplayDisabled: true,
            viaRetryCron: true,
          },
        })
        continue
      }

      const tenantIntegrityError = innerErr instanceof RetryTenantIntegrityError
        ? innerErr
        : tenantIntegrityLookup && isPrismaNotFound(innerErr)
          ? new RetryTenantIntegrityError(tenantIntegrityLookup)
          : null
      if (tenantIntegrityError) {
        const transitioned = await tx.message.updateMany({
          where: {
            id: msg.id,
            tenantId: msg.tenantId,
            status: "RETRYING",
            retryCount: msg.retryCount,
          },
          data: {
            status: "FAILED_PERMANENT",
            nextRetryAt: null,
            errorClass: "TENANT_INTEGRITY",
            errorMessage: tenantIntegrityError.message,
            lastErrorAt: now,
          },
        })
        if (transitioned.count === 1) {
          await updateLinkedNotificationProjection(tx, {
            tenantId: msg.tenantId,
            messageId: msg.id,
            status: "failed",
            error: tenantIntegrityError.message,
          })
          await tx.auditLog.create({
            data: {
              tenantId: msg.tenantId,
              action: "MESSAGE_RETRY_SUPPRESSED_TENANT_INTEGRITY",
              entity: "Message",
              entityId: msg.id,
              oldValue: {
                status: "RETRYING",
                retryCount: msg.retryCount,
              },
              newValue: {
                status: "FAILED_PERMANENT",
                errorClass: "TENANT_INTEGRITY",
                invalidRelation: tenantIntegrityError.relation,
                automaticReplayDisabled: true,
                providerDispatchStarted: false,
                viaRetryCron: true,
              },
            },
          })
          failedPermanent++
        }
        continue
      }

      // Per-row catastrophic failure. Examples:
      //   - PERMANENT: template/Conversation/Contact deleted between
      //     scheduling and retry (Prisma P2025 from findUniqueOrThrow).
      //   - TRANSIENT: DB connection blip during the findUniqueOrThrow,
      //     network timeout to the provider before dispatch().
      //
      // The previous version unconditionally terminated as FAILED_PERMANENT
      // — a single connection blip on a TRANSIENT row burned its retry
      // budget. Classify the error and only terminate if PERMANENT or
      // retries exhausted; otherwise reschedule.
      //
      // classifyError only understands provider-shaped HTTP/SMTP error
      // strings — it has no Prisma awareness, so a real P2025 ("No record
      // was found") falls through to the provider-default which is usually
      // TRANSIENT. Recognise the canonical Prisma "not found" / FK-violation
      // codes explicitly before delegating to classifyError, so we don't
      // burn 5 retries on a deleted template.
      const isPermanentPrismaError =
        innerErr instanceof Prisma.PrismaClientKnownRequestError &&
        (innerErr.code === "P2025" || innerErr.code === "P2003")
      const klass: ErrorClass =
        isPermanentPrismaError ? "PERMANENT" : classifyError(innerErr, msg.provider)
      const nextBackoffMs = klass === "TRANSIENT" ? backoff(msg.retryCount) : null

      if (klass === "PERMANENT" || nextBackoffMs === null) {
        const errorMessage = stringifyError(innerErr)
        const transitioned = await tx.message.updateMany({
          where: {
            id: msg.id,
            tenantId: msg.tenantId,
            status: "RETRYING",
            retryCount: msg.retryCount,
          },
          data: {
            status: "FAILED_PERMANENT",
            retryCount: msg.retryCount + 1,
            errorClass: klass,
            errorMessage,
            lastErrorAt: now,
          },
        })
        if (transitioned.count !== 1) continue
        await updateLinkedNotificationProjection(tx, {
          tenantId: msg.tenantId,
          messageId: msg.id,
          status: "failed",
          error: errorMessage,
        })
        await logAudit({
          tenantId: msg.tenantId,
          action: "MESSAGE_FAILED",
          entity: "Message",
          entityId: msg.id,
          newValue: {
            provider: msg.provider,
            errorClass: klass,
            retryCount: msg.retryCount + 1,
            viaRetryCron: true,
            innerCatch: true,
          },
        })
        failedPermanent++
      } else {
        const nextRetryAt = new Date(now.getTime() + nextBackoffMs)
        const errorMessage = stringifyError(innerErr)
        const transitioned = await tx.message.updateMany({
          where: {
            id: msg.id,
            tenantId: msg.tenantId,
            status: "RETRYING",
            retryCount: msg.retryCount,
          },
          data: {
            status: "RETRYING",
            retryCount: msg.retryCount + 1,
            nextRetryAt,
            errorClass: "TRANSIENT",
            errorMessage,
            lastErrorAt: now,
          },
        })
        if (transitioned.count !== 1) continue
        await updateLinkedNotificationProjection(tx, {
          tenantId: msg.tenantId,
          messageId: msg.id,
          status: "pending",
          error: errorMessage,
        })
        await logAudit({
          tenantId: msg.tenantId,
          action: "MESSAGE_RETRY_ATTEMPTED",
          entity: "Message",
          entityId: msg.id,
          newValue: {
            provider: msg.provider,
            retryCount: msg.retryCount + 1,
            nextRetryAt,
            errorClass: "TRANSIENT",
            viaRetryCron: true,
            innerCatch: true,
          },
        })
        rescheduled++
      }
    }
  }

  return {
    scanned: rows.length,
    expired: expiredResult.count + expiredDunning,
    suppressed,
    dispatched,
    simulated,
    manualReconciliation,
    rescheduled,
    failedPermanent,
  }
}
