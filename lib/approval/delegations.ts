import type { ApprovalDelegation } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { activeCurrency } from "@/lib/jurisdiction/active"
import { formatMoney } from "@/lib/jurisdiction/money"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import type { UserRole } from "@/lib/permissions"
import { delegationProblems, type DelegationInput } from "./delegation-rules"
import { loadEffectiveMatrix } from "./matrix-store"
import { notifyStaff } from "./notify"

export class DelegationError extends Error {
  constructor(readonly code: "NO_MATRIX" | "FORBIDDEN" | "NOT_FOUND" | "INVALID" | "ALREADY_ENDED", readonly status: number, message: string, readonly problems: readonly string[] = []) {
    super(message)
    this.name = "DelegationError"
  }
}

export interface Actor {
  id: string
  email: string
  role: UserRole
}

/**
 * Records a delegation of the delegator's own authority (the actor's, or, for an administrator, someone else's) and tells the delegate.
 * The matrix must be in force: a level means nothing without it. The database re-checks both people are active staff of the lender.
 */
export async function grantDelegation(input: {
  tenantId: string; actor: Actor; delegation: Omit<DelegationInput, "delegatorId"> & { delegatorId?: string }; now?: Date
}): Promise<ApprovalDelegation> {
  const now = input.now ?? new Date()
  const delegatorId = input.delegation.delegatorId ?? input.actor.id
  if (delegatorId !== input.actor.id && !canDo(input.actor.role, "manage_approval_delegations_any")) {
    throw new DelegationError("FORBIDDEN", 403, "You can delegate your own authority only; an administrator may record one for someone else.")
  }
  const matrix = await loadEffectiveMatrix(prisma, input.tenantId, now)
  if (!matrix) throw new DelegationError("NO_MATRIX", 409, "No approval matrix is in force, so there is no authority to delegate.")
  const users = await prisma.user.findMany({ where: { tenantId: input.tenantId, id: { in: [delegatorId, input.delegation.delegateId] }, active: true, isSystem: false }, select: { id: true, role: true } })
  const delegator = users.find((u) => u.id === delegatorId)
  const delegate = users.find((u) => u.id === input.delegation.delegateId)
  if (!delegator || !delegate) throw new DelegationError("INVALID", 422, "Both people must be active staff of the lender.", ["delegator or delegate"])
  const delegation = { ...input.delegation, delegatorId }
  const problems = delegationProblems({ input: delegation, delegatorRole: delegator.role, delegateRole: delegate.role, levels: matrix.payload.levels, now, actorId: input.actor.id, actorRole: input.actor.role })
  if (problems.length > 0) throw new DelegationError("INVALID", 422, problems[0], problems)
  return prisma.$transaction(async (tx) => {
    const created = await tx.approvalDelegation.create({
      data: { tenantId: input.tenantId, delegatorId, delegateId: delegation.delegateId, level: delegation.level, maxAmountCents: delegation.maxAmountCents, validFrom: delegation.validFrom, validTo: delegation.validTo, reason: delegation.reason.trim(), createdById: input.actor.id },
    })
    await logAuditStrict({
      tenantId: input.tenantId, userId: input.actor.id, userEmail: input.actor.email, action: AuditAction.APPROVAL_DELEGATION_GRANTED,
      entity: "ApprovalDelegation", entityId: created.id,
      newValue: { ...(delegatorId !== input.actor.id ? { onBehalfOf: delegatorId, recordedBy: input.actor.id } : {}), delegatorId, delegateId: delegation.delegateId, level: delegation.level, maxAmountCents: delegation.maxAmountCents, validFrom: delegation.validFrom.toISOString(), validTo: delegation.validTo.toISOString(), reason: created.reason },
    }, tx)
    await notifyStaff(tx, {
      tenantId: input.tenantId, userIds: [delegation.delegateId], type: "APPROVAL_DELEGATED", title: "Approval authority delegated to you",
      body: `Level ${delegation.level} up to ${formatMoney(delegation.maxAmountCents, activeCurrency())}, until ${delegation.validTo.toISOString().slice(0, 10)}.`,
    })
    // On someone's behalf: the delegator is told what was done in their name.
    if (delegatorId !== input.actor.id) {
      await notifyStaff(tx, {
        tenantId: input.tenantId, userIds: [delegatorId], type: "APPROVAL_DELEGATED_ON_YOUR_BEHALF", title: "Your approval authority was delegated on your behalf",
        body: `${input.actor.email} delegated your level ${delegation.level} authority, up to ${formatMoney(delegation.maxAmountCents, activeCurrency())}, until ${delegation.validTo.toISOString().slice(0, 10)}. Revoke it under Settings, Approval Matrix, if this is wrong.`,
      })
    }
    return created
  })
}

/** Ends a delegation now: by its delegator, whoever recorded it, or an administrator. It is never edited or deleted. */
export async function revokeDelegation(input: { tenantId: string; actor: Actor; id: string; now?: Date }): Promise<ApprovalDelegation> {
  const now = input.now ?? new Date()
  const row = await prisma.approvalDelegation.findFirst({ where: { id: input.id, tenantId: input.tenantId } })
  if (!row) throw new DelegationError("NOT_FOUND", 404, "Delegation not found.")
  if (row.revokedAt !== null) throw new DelegationError("ALREADY_ENDED", 409, "This delegation has already been revoked.")
  const mayRevoke = row.delegatorId === input.actor.id || row.createdById === input.actor.id || canDo(input.actor.role, "manage_approval_delegations_any")
  if (!mayRevoke) throw new DelegationError("FORBIDDEN", 403, "Only the delegator, whoever recorded it, or an administrator can revoke a delegation.")
  return prisma.$transaction(async (tx) => {
    const changed = await tx.approvalDelegation.updateMany({ where: { id: row.id, tenantId: input.tenantId, revokedAt: null }, data: { revokedAt: now, revokedById: input.actor.id } })
    if (changed.count !== 1) throw new DelegationError("ALREADY_ENDED", 409, "This delegation has already been revoked.")
    await logAuditStrict({
      tenantId: input.tenantId, userId: input.actor.id, userEmail: input.actor.email, action: AuditAction.APPROVAL_DELEGATION_REVOKED,
      entity: "ApprovalDelegation", entityId: row.id, newValue: { delegatorId: row.delegatorId, delegateId: row.delegateId, level: row.level },
    }, tx)
    return tx.approvalDelegation.findUniqueOrThrow({ where: { id: row.id } })
  })
}

/** The lender's delegations, newest first, with their people's names; ended and expired ones included for the record. */
export async function listDelegations(tenantId: string, opts: { limit?: number } = {}) {
  const rows = await prisma.approvalDelegation.findMany({
    where: { tenantId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(1, opts.limit ?? 100), 200),
    include: { delegator: { select: { name: true, email: true } }, delegate: { select: { name: true, email: true } } },
  })
  return rows
}
