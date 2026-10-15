/**
 * Mandate status changes: the one writer of DebitMandate.status. Each move is
 * checked against the state machine (and again by the guardDebitMandateStatus
 * trigger) and audited in the same transaction. Suspending or cancelling a
 * mandate cancels its not-yet-submitted instructions with it.
 *
 * Submission is claimed first (CREATED → SUBMITTING), so a staff create and the
 * cron can never both call the provider for one mandate. A failure that proves
 * nothing was sent cancels the mandate; any other failure returns it to
 * CREATED with a doubling backoff, and after MAX_SUBMIT_ATTEMPTS a person is
 * asked (reviewReason) instead of retrying forever.
 */
import type { DebitMandateStatus, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { avsWireAccountType } from "@/lib/avs"
import { LOAD_REPORT_TIMEOUT_HOURS, MANDATE_AMOUNT_TYPE, MAX_SUBMIT_ATTEMPTS, STUCK_SUBMISSION_HOURS, submitBackoffMs } from "./scheme-rules"
import { canTransition, fromProviderStatus } from "./state-machine"
import { ENGINE_ACTOR, definitelyNotSent, errorSummary, type EngineContext } from "./context"

export interface Actor {
  userId: string | null
  userEmail: string | null
}

export const engineActor: Actor = { userId: ENGINE_ACTOR.userId, userEmail: ENGINE_ACTOR.userEmail }

type MandateSet = Pick<Prisma.DebitMandateUncheckedUpdateManyInput,
  "providerMandateRef" | "simulated" | "submitAttempts" | "nextAttemptAt" | "reviewReason" | "providerCancelledAt">

/**
 * Move a mandate from `from` to `to`. Returns false, writing nothing, when the
 * mandate is no longer in `from` (another writer got there first).
 */
export async function transitionMandate(args: {
  tenantId: string
  mandateId: string
  from: DebitMandateStatus
  to: DebitMandateStatus
  reason: string
  actor: Actor
  now: Date
  set?: MandateSet
}): Promise<boolean> {
  if (!canTransition(args.from, args.to)) {
    throw new Error(`A mandate cannot move from ${args.from} to ${args.to}`)
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.debitMandate.updateMany({
      where: { id: args.mandateId, tenantId: args.tenantId, status: args.from },
      data: { status: args.to, statusReason: args.reason, statusChangedAt: args.now, ...args.set },
    })
    if (updated.count === 0) return false
    let cancelledInstructions = 0
    if (args.to === "SUSPENDED" || args.to === "CANCELLED" || args.to === "EXPIRED" || args.to === "REJECTED") {
      const cancelled = await tx.collectionInstruction.updateMany({
        where: { tenantId: args.tenantId, mandateId: args.mandateId, status: "PENDING" },
        data: { status: "CANCELLED", statusReason: `Mandate ${args.to.toLowerCase()}: ${args.reason}` },
      })
      cancelledInstructions = cancelled.count
    }
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.userId ?? undefined,
      userEmail: args.actor.userEmail ?? undefined,
      action: AuditAction.COLLECTION_MANDATE_STATUS_CHANGED,
      entity: "DebitMandate",
      entityId: args.mandateId,
      oldValue: { status: args.from },
      newValue: { status: args.to, reason: args.reason, cancelledInstructions, ...args.set },
    }, tx)
    return true
  })
}

/**
 * Keep a provider reference even when the local transition lost a race (staff
 * cancelled while the call was in flight): without it the provider would hold
 * a live mandate nothing here can cancel. The cancel sweep acts on it.
 */
export async function keepProviderReference(ctx: EngineContext, mandateId: string, ref: string | null, simulated: boolean): Promise<void> {
  if (!ref) return
  await prisma.$transaction(async (tx) => {
    const kept = await tx.debitMandate.updateMany({
      where: { id: mandateId, tenantId: ctx.tenantId, providerMandateRef: null },
      data: { providerMandateRef: ref, ...(simulated ? { simulated: true } : {}) },
    })
    if (kept.count === 0) return
    await logAuditStrict({
      tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
      action: AuditAction.COLLECTION_MANDATE_PROVIDER_REF_RECORDED, entity: "DebitMandate", entityId: mandateId,
      newValue: { providerMandateRef: ref, afterLostRace: true },
    }, tx)
  })
}

/** Put a mandate in front of a person (once): the engine will not decide this alone. */
export async function flagMandateForReview(ctx: EngineContext, mandateId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const flagged = await tx.debitMandate.updateMany({ where: { id: mandateId, tenantId: ctx.tenantId, reviewReason: null }, data: { reviewReason: reason } })
    if (flagged.count === 0) return false
    await logAuditStrict({
      tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
      action: AuditAction.COLLECTION_MANDATE_NEEDS_REVIEW, entity: "DebitMandate", entityId: mandateId, newValue: { reason },
    }, tx)
    return true
  })
}

async function recordSubmissionFailure(ctx: EngineContext, mandateId: string, attempts: number, error: unknown): Promise<DebitMandateStatus> {
  const summary = errorSummary(error)
  await logAuditStrict({
    tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
    action: AuditAction.COLLECTION_MANDATE_SUBMISSION_FAILED, entity: "DebitMandate", entityId: mandateId,
    newValue: { provider: ctx.provider.id, error: summary, attempts, retried: !definitelyNotSent(error) },
  })
  if (definitelyNotSent(error)) {
    await transitionMandate({
      tenantId: ctx.tenantId, mandateId, from: "SUBMITTING", to: "CANCELLED",
      reason: `Not sent: ${summary}`, actor: engineActor, now: ctx.now,
    })
    return "CANCELLED"
  }
  const exhausted = attempts >= MAX_SUBMIT_ATTEMPTS
  await transitionMandate({
    tenantId: ctx.tenantId, mandateId, from: "SUBMITTING", to: "CREATED",
    reason: `Submission failed (attempt ${attempts}): ${summary}`, actor: engineActor, now: ctx.now,
    set: {
      submitAttempts: attempts,
      nextAttemptAt: new Date(ctx.now.getTime() + submitBackoffMs(attempts)),
      reviewReason: exhausted ? `Provider submission failed ${attempts} times: ${summary}` : null,
    },
  })
  return "CREATED"
}

/**
 * Send a CREATED mandate to the provider. Returns the resulting status, or
 * null when another writer holds the claim or its retry is not yet due.
 */
export async function submitMandate(ctx: EngineContext, mandateId: string): Promise<DebitMandateStatus | null> {
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: ctx.now } }] }
  const claimed = await prisma.$transaction(async (tx) => {
    const won = await tx.debitMandate.updateMany({
      where: { id: mandateId, tenantId: ctx.tenantId, status: "CREATED", reviewReason: null, ...due },
      data: { status: "SUBMITTING", statusChangedAt: ctx.now, statusReason: `Submitting to ${ctx.provider.id}`, providerContactedAt: ctx.now },
    })
    if (won.count === 1) {
      await logAuditStrict({
        tenantId: ctx.tenantId, userEmail: ENGINE_ACTOR.userEmail,
        action: AuditAction.COLLECTION_MANDATE_STATUS_CHANGED, entity: "DebitMandate", entityId: mandateId,
        oldValue: { status: "CREATED" }, newValue: { status: "SUBMITTING", provider: ctx.provider.id },
      }, tx)
    }
    return won.count
  })
  if (claimed === 0) return null
  const m = await prisma.debitMandate.findFirstOrThrow({
    where: { id: mandateId, tenantId: ctx.tenantId },
    include: {
      loan: { select: { reference: true } },
      client: { select: { firstName: true, lastName: true, idNumber: true, phone: true } },
    },
  })
  let handle
  try {
    handle = await ctx.provider.createMandate({
      mandateReference: m.id,
      loanReference: m.loan.reference,
      debtor: m.client,
      account: {
        accountHolder: m.accountHolder, idNumber: m.client.idNumber, bankName: m.bankName, branchCode: m.branchCode,
        accountNumber: m.accountNumber, accountType: avsWireAccountType(m.accountType as Parameters<typeof avsWireAccountType>[0]),
      },
      amountType: MANDATE_AMOUNT_TYPE,
      instalmentAmountCents: m.amountCents,
      maxCollectionAmountCents: m.maxAmountCents,
      debitDayOfMonth: m.debitDay,
      authType: m.authType,
      frequency: m.frequency,
      firstCollectionDate: m.firstCollectionDate,
      trackingDays: m.trackingDays,
      adjustment: m.adjustment,
    }, ctx.creds)
  } catch (error) {
    return recordSubmissionFailure(ctx, m.id, m.submitAttempts + 1, error)
  }
  const to = fromProviderStatus(handle.status)
  if (!canTransition("SUBMITTING", to) || to === "CREATED") {
    return recordSubmissionFailure(ctx, m.id, m.submitAttempts + 1, new Error(`Provider answered a new mandate with ${handle.status}`))
  }
  const moved = await transitionMandate({
    tenantId: ctx.tenantId, mandateId: m.id, from: "SUBMITTING", to,
    reason: `Submitted to ${ctx.provider.id}`, actor: engineActor, now: ctx.now,
    set: { providerMandateRef: handle.providerMandateRef, simulated: handle.simulated === true },
  })
  if (moved && to !== "PENDING_REGISTRATION" && !handle.providerMandateRef) {
    await flagMandateForReview(ctx, m.id, `${ctx.provider.id} answered ${handle.status} without a reference: obtain it from the provider`)
  }
  if (!moved) {
    // Cancelled while the call was in flight: keep what the provider gave us.
    await keepProviderReference(ctx, m.id, handle.providerMandateRef, handle.simulated === true)
    return (await prisma.debitMandate.findFirstOrThrow({ where: { id: m.id, tenantId: ctx.tenantId }, select: { status: true } })).status
  }
  return to
}

/**
 * A SUBMITTING claim older than STUCK_SUBMISSION_HOURS lost its answer (a
 * crash mid-call). Ask the provider by our reference where it can; otherwise
 * retry, which is safe because the provider deduplicates on that reference.
 */
async function reconcileStuckSubmission(ctx: EngineContext, mandateId: string, attempts: number): Promise<boolean> {
  const found = ctx.provider.findMandate ? await ctx.provider.findMandate(mandateId, ctx.creds) : null
  if (found) {
    const to = fromProviderStatus(found.status)
    if (canTransition("SUBMITTING", to) && to !== "CREATED") {
      const moved = await transitionMandate({
        tenantId: ctx.tenantId, mandateId, from: "SUBMITTING", to, reason: `${ctx.provider.id} reported ${to} on reconcile`,
        actor: engineActor, now: ctx.now, set: { providerMandateRef: found.providerMandateRef, simulated: found.simulated === true },
      })
      if (!moved) await keepProviderReference(ctx, mandateId, found.providerMandateRef, found.simulated === true)
      return moved
    }
  }
  await recordSubmissionFailure(ctx, mandateId, attempts + 1, new Error("Submission outcome lost; retrying under the same reference"))
  return true
}

/**
 * A SUSPENDED report for an ACTIVE mandate is applied only when two
 * consecutive refreshes say so: the first records it and raises a review item;
 * any other answer in between resets it. True while the change must wait.
 */
async function suspendedNeedsSecondReport(ctx: EngineContext, mandateId: string, to: DebitMandateStatus, firstReportAt: Date | null): Promise<boolean> {
  if (to !== "SUSPENDED") {
    if (firstReportAt) {
      await prisma.debitMandate.updateMany({ where: { id: mandateId, tenantId: ctx.tenantId }, data: { providerSuspendReportedAt: null } })
    }
    return false
  }
  if (firstReportAt) return false
  await prisma.debitMandate.updateMany({ where: { id: mandateId, tenantId: ctx.tenantId, providerSuspendReportedAt: null }, data: { providerSuspendReportedAt: ctx.now } })
  await flagMandateForReview(ctx, mandateId,
    `${ctx.provider.id} reported SUSPENDED once: it is applied if the next refresh reports it again; check with the provider and the client`)
  return true
}

export interface RefreshSummary {
  checked: number
  changed: number
  errors: string[]
}

/** Submit due mandates, reconcile lost submissions, and read back the provider's view of the rest. */
export async function refreshMandates(ctx: EngineContext): Promise<RefreshSummary> {
  const stuckBefore = new Date(ctx.now.getTime() - STUCK_SUBMISSION_HOURS * 3_600_000)
  const registrationTimeout = new Date(ctx.now.getTime() - LOAD_REPORT_TIMEOUT_HOURS * 3_600_000)
  const mandates = await prisma.debitMandate.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, status: { in: ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE"] } },
    select: { id: true, status: true, providerMandateRef: true, submitAttempts: true, reviewReason: true, statusChangedAt: true, providerSuspendReportedAt: true },
    orderBy: { createdAt: "asc" },
  })
  const summary: RefreshSummary = { checked: mandates.length, changed: 0, errors: [] }
  for (const m of mandates) {
    try {
      if (m.status === "CREATED") {
        if (m.reviewReason) continue
        const submitted = await submitMandate(ctx, m.id)
        if (submitted === null) continue
        summary.changed++
        // A file-based rail may register it at once: read that back in this run.
        if (submitted !== "PENDING_REGISTRATION") continue
        m.status = submitted
      }
      if (m.status === "SUBMITTING") {
        // statusChangedAt is the claim time, from the engine clock.
        if (m.statusChangedAt < stuckBefore && (await reconcileStuckSubmission(ctx, m.id, m.submitAttempts))) summary.changed++
        continue
      }
      let current: { status: DebitMandateStatus; ref: string | null } = { status: m.status, ref: m.providerMandateRef }
      if (m.status === "PENDING_REGISTRATION") {
        const found = ctx.provider.findMandate ? await ctx.provider.findMandate(m.id, ctx.creds) : null
        const to = found ? fromProviderStatus(found.status) : null
        if (found && to !== "PENDING_REGISTRATION" && !found.providerMandateRef) {
          // Registered (or decided) at the provider but no reference to poll or cancel it by.
          await flagMandateForReview(ctx, m.id, `${ctx.provider.id} reported the mandate ${found.status} without a reference: obtain it from the provider`)
          continue
        }
        if (!found || !to || to === "PENDING_REGISTRATION" || !canTransition(m.status, to)) {
          if (m.statusChangedAt < registrationTimeout) {
            await flagMandateForReview(ctx, m.id,
              `Uploaded to ${ctx.provider.id} but not registered after ${LOAD_REPORT_TIMEOUT_HOURS} hours: confirm with the provider, or cancel it`)
          }
          continue
        }
        const moved = await transitionMandate({
          tenantId: ctx.tenantId, mandateId: m.id, from: m.status, to, reason: `${ctx.provider.id} registered the mandate`,
          actor: engineActor, now: ctx.now, set: { providerMandateRef: found.providerMandateRef, reviewReason: null },
        })
        if (!moved) {
          await keepProviderReference(ctx, m.id, found.providerMandateRef, found.simulated === true)
          continue
        }
        summary.changed++
        current = { status: to, ref: found.providerMandateRef }
      }
      // Registered just now or earlier: read the debtor's answer in the same run.
      if (!current.ref || (current.status !== "PENDING_AUTH" && current.status !== "ACTIVE")) continue
      const to = fromProviderStatus(await ctx.provider.getMandateStatus(current.ref, ctx.creds))
      if (current.status === "ACTIVE" && (await suspendedNeedsSecondReport(ctx, m.id, to, m.providerSuspendReportedAt))) continue
      if (to === current.status || !canTransition(current.status, to)) continue
      const ended = to === "CANCELLED" || to === "SUSPENDED" || to === "EXPIRED" || to === "REJECTED"
      const moved = await transitionMandate({
        tenantId: ctx.tenantId, mandateId: m.id, from: current.status, to,
        reason: `${ctx.provider.id} reported ${to}`, actor: engineActor, now: ctx.now,
        set: ended ? { providerCancelledAt: ctx.now } : undefined,
      })
      if (moved) summary.changed++
      // The bank ended a mandate we were collecting on: a person follows it up with the client.
      if (moved && current.status === "ACTIVE" && to !== "CANCELLED") {
        await flagMandateForReview(ctx, m.id, `${ctx.provider.id} reported ${to} for an active mandate: contact the client and arrange another way to pay`)
      }
    } catch (error) {
      summary.errors.push(`${m.id}: ${errorSummary(error)}`)
    }
  }
  return summary
}
