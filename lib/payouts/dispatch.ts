/**
 * Sending a payout: claim, then call, then record. Never the other way round.
 *
 * The claim is a status-pinned update PENDING -> SUBMITTING, committed (with
 * its audit row) BEFORE the provider is called. Two dispatchers racing for one
 * payout: exactly one update matches, the other finds nothing to claim and
 * sends nothing. A crash after the claim leaves SUBMITTING, which a person
 * resolves (lib/payouts/resolve.ts); nothing ever re-sends a claimed payout.
 *
 * The provider's answer maps to: accepted -> its state; rejected (definitely
 * not sent) -> FAILED; anything else, including a throw -> NEEDS_REVIEW.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { getPayoutProvider } from "./registry"
import { canTransition, isSettled, statusAfterSend, type PayoutStatus } from "./state"
import type { InitiateResult, PayoutProvider } from "./types"

export type PayoutDb = Pick<typeof prisma, "disbursementPayout" | "auditLog" | "$transaction">

export interface Actor {
  id: string | null
  email: string
}

export type DispatchOutcome =
  | { kind: "not_claimed"; status: PayoutStatus | null }
  | { kind: "not_sendable"; reason: string }
  | { kind: "sent"; status: PayoutStatus; result: InitiateResult["kind"] }

/**
 * Moves a payout from `from` to `to` only if it is still at `from`, with its
 * audit row in the same transaction. False when someone else moved it first.
 */
export async function transitionPayout(db: PayoutDb, args: {
  tenantId: string
  payoutId: string
  from: PayoutStatus
  to: PayoutStatus
  data?: Record<string, unknown>
  actor: Actor
  source: string
  detail?: Record<string, unknown>
}): Promise<boolean> {
  if (!canTransition(args.from, args.to)) return false
  return db.$transaction(async (tx) => {
    const now = new Date()
    const moved = await tx.disbursementPayout.updateMany({
      where: { id: args.payoutId, tenantId: args.tenantId, status: args.from },
      data: { status: args.to, ...(isSettled(args.to) ? { resolvedAt: now } : {}), ...args.data },
    })
    if (moved.count !== 1) return false
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id ?? undefined,
      userEmail: args.actor.email,
      action: AuditAction.PAYOUT_STATUS_CHANGED,
      entity: "DisbursementPayout",
      entityId: args.payoutId,
      oldValue: { status: args.from },
      newValue: { status: args.to, source: args.source, ...args.detail },
    }, tx)
    return true
  })
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "provider call failed"
}

export async function dispatchPayout(db: PayoutDb, args: { tenantId: string; payoutId: string; actor: Actor }): Promise<DispatchOutcome> {
  const payout = await db.disbursementPayout.findFirst({ where: { id: args.payoutId, tenantId: args.tenantId } })
  if (!payout) return { kind: "not_claimed", status: null }
  if (payout.status !== "PENDING") return { kind: "not_claimed", status: payout.status }

  // Resolve the channel BEFORE claiming: a misconfigured channel leaves the
  // payout PENDING (never sent) for a person to send once it is fixed.
  let provider: PayoutProvider
  try {
    provider = getPayoutProvider(payout.provider)
  } catch (error) {
    return { kind: "not_sendable", reason: reasonOf(error) }
  }

  const claimed = await transitionPayout(db, {
    tenantId: args.tenantId, payoutId: payout.id, from: "PENDING", to: "SUBMITTING",
    data: { submittedAt: new Date() }, actor: args.actor, source: "dispatch", detail: { provider: provider.id },
  })
  if (!claimed) return { kind: "not_claimed", status: null }

  let result: InitiateResult
  try {
    result = await provider.initiatePayout({
      tenantId: args.tenantId,
      beneficiary: {
        accountHolder: payout.accountHolder, bankName: payout.bankName, branchCode: payout.branchCode,
        accountNumber: payout.accountNumber, accountType: payout.accountType,
      },
      amountCents: payout.amountCents,
      reference: payout.reference,
      idempotencyKey: payout.idempotencyKey,
    })
  } catch (error) {
    result = { kind: "unknown", reason: reasonOf(error) }
  }

  const to: PayoutStatus = result.kind === "accepted" ? statusAfterSend(result.state)
    : result.kind === "rejected" ? "FAILED"
      : "NEEDS_REVIEW"
  const data = result.kind === "accepted"
    ? { providerReference: result.providerReference, simulated: result.simulated === true }
    : { failureReason: result.reason.slice(0, 500) }
  const recorded = await transitionPayout(db, {
    tenantId: args.tenantId, payoutId: payout.id, from: "SUBMITTING", to, data,
    actor: args.actor, source: "dispatch", detail: { result: result.kind, ...data },
  })
  if (!recorded) {
    // Someone moved it while the call was in flight (a staff review). Their
    // word stands; this answer is in the audit trail only.
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id ?? undefined, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_STATUS_CHANGED, entity: "DisbursementPayout", entityId: payout.id,
      newValue: { ignoredProviderAnswer: result.kind, wanted: to, ...data },
    }, db)
    const now = await db.disbursementPayout.findFirst({ where: { id: payout.id, tenantId: args.tenantId }, select: { status: true } })
    return { kind: "sent", status: now?.status ?? to, result: result.kind }
  }
  return { kind: "sent", status: to, result: result.kind }
}
