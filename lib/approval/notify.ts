import type { Tx } from "@/lib/maker-checker/types"
import { roleLevel } from "./evaluate"
import type { MatrixLevel } from "./types"

/**
 * Staff who should hear that an application is waiting at a level: active people whose own role level is exactly this one
 * (a higher role is not woken for work its juniors can do), and anyone with a live delegation of this level or above. Never the system
 * account, the maker or anyone who has already approved it.
 */
export async function approversForLevel(
  tx: Pick<Tx, "user" | "approvalDelegation">,
  input: { tenantId: string; levels: readonly MatrixLevel[]; level: number; amountCents: number; exclude: readonly string[]; now: Date },
): Promise<string[]> {
  const users = await tx.user.findMany({
    where: { tenantId: input.tenantId, active: true, isSystem: false, id: { notIn: [...input.exclude] }, role: { in: ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] } },
    select: { id: true, role: true },
  })
  const byRole = users.filter((u) => roleLevel(input.levels, u.role) === input.level).map((u) => u.id)
  const delegations = await tx.approvalDelegation.findMany({
    where: { tenantId: input.tenantId, revokedAt: null, validFrom: { lte: input.now }, validTo: { gte: input.now }, level: { gte: input.level }, maxAmountCents: { gte: input.amountCents }, delegateId: { notIn: [...input.exclude] } },
    select: { delegateId: true },
  })
  // A delegate who has since left (or is the system account) is not woken for work they can no longer do.
  const delegateIds = [...new Set(delegations.map((d) => d.delegateId))]
  const active = delegateIds.length === 0
    ? []
    : (await tx.user.findMany({ where: { tenantId: input.tenantId, id: { in: delegateIds }, active: true, isSystem: false }, select: { id: true } })).map((u) => u.id)
  return [...new Set([...byRole, ...active])]
}

/** One in-app (bell) notification per recipient, deep-linking to the application. */
export async function notifyStaff(
  tx: Pick<Tx, "notification">,
  input: { tenantId: string; userIds: readonly string[]; type: string; title: string; body: string; applicationId?: string },
): Promise<void> {
  if (input.userIds.length === 0) return
  await tx.notification.createMany({
    data: input.userIds.map((userId) => ({ tenantId: input.tenantId, userId, type: input.type, title: input.title, body: input.body, entityType: input.applicationId ? "LoanApplication" : null, entityId: input.applicationId ?? null })),
  })
}
