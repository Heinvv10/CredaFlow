/**
 * Mandate status changes: the one writer of DebitMandate.status. Each move is
 * checked against the state machine (and again by the guardDebitMandateStatus
 * trigger) and audited in the same transaction. Suspending or cancelling a
 * mandate cancels its not-yet-submitted instructions with it.
 */
import type { DebitMandate, DebitMandateStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { avsWireAccountType } from "@/lib/avs"
import { MANDATE_AMOUNT_TYPE } from "./scheme-rules"
import { canTransition, fromProviderStatus } from "./state-machine"
import { ENGINE_ACTOR, definitelyNotSent, errorSummary, type EngineContext } from "./context"

export interface Actor {
  userId: string | null
  userEmail: string | null
}

export const engineActor: Actor = { userId: ENGINE_ACTOR.userId, userEmail: ENGINE_ACTOR.userEmail }

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
  set?: { providerMandateRef?: string | null; simulated?: boolean }
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
    if (args.to === "SUSPENDED" || args.to === "CANCELLED") {
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
 * Send a CREATED mandate to the provider for the debtor's authorisation. Safe
 * to retry: the mandate id is the provider-side reference. A failure that
 * proves nothing reached the provider (e.g. an adapter that cannot register
 * mandates yet) cancels the mandate; any other failure leaves it CREATED for
 * the submit cron to retry.
 */
export async function submitMandate(ctx: EngineContext, mandate: DebitMandate, loanReference: string, debtor: {
  firstName: string
  lastName: string
  idNumber: string
  phone: string
}): Promise<DebitMandateStatus> {
  let handle
  try {
    handle = await ctx.provider.createMandate({
      mandateReference: mandate.id,
      loanReference,
      debtor,
      account: {
        accountHolder: mandate.accountHolder,
        idNumber: debtor.idNumber,
        bankName: mandate.bankName,
        branchCode: mandate.branchCode,
        accountNumber: mandate.accountNumber,
        accountType: avsWireAccountType(mandate.accountType as Parameters<typeof avsWireAccountType>[0]),
      },
      amountType: MANDATE_AMOUNT_TYPE,
      instalmentAmountCents: mandate.amountCents,
      maxCollectionAmountCents: mandate.maxAmountCents,
      debitDayOfMonth: mandate.debitDay,
      authType: mandate.authType,
      frequency: mandate.frequency,
      firstCollectionDate: mandate.firstCollectionDate,
      trackingDays: mandate.trackingDays,
      adjustment: mandate.adjustment,
    }, ctx.creds)
  } catch (error) {
    const notSent = definitelyNotSent(error)
    await prisma.$transaction(async (tx) => {
      await tx.debitMandate.updateMany({
        where: { id: mandate.id, tenantId: ctx.tenantId, status: "CREATED" },
        data: { statusReason: `Submission failed: ${errorSummary(error)}` },
      })
      await logAuditStrict({
        tenantId: ctx.tenantId,
        userEmail: ENGINE_ACTOR.userEmail,
        action: AuditAction.COLLECTION_MANDATE_SUBMISSION_FAILED,
        entity: "DebitMandate",
        entityId: mandate.id,
        newValue: { provider: ctx.provider.id, error: errorSummary(error), retried: !notSent },
      }, tx)
    })
    if (!notSent) return "CREATED"
    await transitionMandate({
      tenantId: ctx.tenantId, mandateId: mandate.id, from: "CREATED", to: "CANCELLED",
      reason: `Not sent: ${errorSummary(error)}`, actor: engineActor, now: ctx.now,
    })
    return "CANCELLED"
  }
  const to = fromProviderStatus(handle.status)
  const set = { providerMandateRef: handle.providerMandateRef, simulated: handle.simulated === true }
  if (to === "CREATED" || !canTransition("CREATED", to)) {
    throw new Error(`Provider answered a new mandate with ${handle.status}`)
  }
  await transitionMandate({
    tenantId: ctx.tenantId, mandateId: mandate.id, from: "CREATED", to,
    reason: `Submitted to ${ctx.provider.id}`, actor: engineActor, now: ctx.now, set,
  })
  return to
}

export interface RefreshSummary {
  checked: number
  changed: number
  errors: string[]
}

/** Retry CREATED submissions and read back the provider's view of pending and active mandates. */
export async function refreshMandates(ctx: EngineContext): Promise<RefreshSummary> {
  const mandates = await prisma.debitMandate.findMany({
    where: { tenantId: ctx.tenantId, provider: ctx.provider.id, status: { in: ["CREATED", "PENDING_AUTH", "ACTIVE"] } },
    include: { loan: { select: { reference: true } }, client: { select: { firstName: true, lastName: true, idNumber: true, phone: true } } },
    orderBy: { createdAt: "asc" },
  })
  const summary: RefreshSummary = { checked: mandates.length, changed: 0, errors: [] }
  for (const m of mandates) {
    try {
      if (m.status === "CREATED") {
        if ((await submitMandate(ctx, m, m.loan.reference, m.client)) !== "CREATED") summary.changed++
        continue
      }
      if (!m.providerMandateRef) continue
      const to = fromProviderStatus(await ctx.provider.getMandateStatus(m.providerMandateRef, ctx.creds))
      if (to === m.status || !canTransition(m.status, to)) continue
      const moved = await transitionMandate({
        tenantId: ctx.tenantId, mandateId: m.id, from: m.status, to,
        reason: `${ctx.provider.id} reported ${to}`, actor: engineActor, now: ctx.now,
      })
      if (moved) summary.changed++
    } catch (error) {
      summary.errors.push(`${m.id}: ${errorSummary(error)}`)
    }
  }
  return summary
}
