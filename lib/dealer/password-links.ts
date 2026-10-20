/**
 * One-time set-password links for dealer users. Creating a user (staff or a
 * DEALER_ADMIN, lib/dealer/users.ts) and a staff "reset link" each issue one:
 * 32 random bytes, stored only as their sha256 (DealerUser.setPasswordTokenHash),
 * valid 72 hours, replacing any earlier link. Nothing is emailed in this slice:
 * the creator is shown the link to pass on. A token is never written to an
 * audit row. A reset link also bumps tokenVersion, ending the user's sessions,
 * and clears the password, so whoever holds the old one cannot sign straight
 * back in before the user opens the link. No link for a deactivated dealer.
 *
 * Setting the password (public, the token is the credential) is bound to the
 * lender the dealer host resolves, single-use (compare-and-swap on the hash),
 * judged by the house password policy, and bumps tokenVersion.
 */
import { createHash, randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { requireDealerBaseUrl } from "@/lib/config/deployment-urls"
import { passwordPolicyError } from "@/lib/security/password-policy"
import { runWithTenant, withoutTenantScope } from "@/lib/tenant-scope"
import { dealerAuditFields, type StaffActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const DEALER_LINK_HOURS = 72

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export const hashDealerToken = (token: string) => createHash("sha256").update(token).digest("hex")

/** Where a dealer user sets a password: the dealer host. */
export function dealerPasswordUrl(token: string): string {
  return `${requireDealerBaseUrl()}/dealer/set-password?token=${token}`
}

/** A fresh link on the user, replacing any earlier one. Returns the token (shown once). */
export async function writeDealerLink(
  tx: Pick<Tx, "dealerUser">,
  tenantId: string,
  dealerUserId: string,
  opts: { bumpTokenVersion: boolean; clearPassword?: boolean },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(now.getTime() + DEALER_LINK_HOURS * 3_600_000)
  await tx.dealerUser.update({
    where: { id: dealerUserId, tenantId },
    data: {
      setPasswordTokenHash: hashDealerToken(token),
      setPasswordTokenExp: expiresAt,
      ...(opts.bumpTokenVersion ? { tokenVersion: { increment: 1 } } : {}),
      ...(opts.clearPassword ? { passwordHash: null } : {}),
    },
  })
  return { token, expiresAt }
}

/** Staff "reset link": a fresh link; the old password stops working and every session of the user ends. */
export async function issueDealerPasswordLink(
  staff: StaffActor,
  dealerId: string,
  dealerUserId: string,
): Promise<{ kind: "issued"; token: string; expiresAt: Date } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.dealerUser.findFirst({
      where: { id: dealerUserId, tenantId: staff.tenantId, dealerId },
      select: { id: true, active: true, dealer: { select: { active: true } } },
    })
    if (!user) return dealerMiss("Dealer user")
    if (!user.dealer.active) return dealerRefused(409, "The dealer is deactivated")
    if (!user.active) return dealerRefused(409, "The dealer user is deactivated")
    const link = await writeDealerLink(tx, staff.tenantId, user.id, { bumpTokenVersion: true, clearPassword: true })
    await logAuditStrict({
      tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_USER_PASSWORD_LINK_ISSUED, entity: "DealerUser", entityId: user.id,
      newValue: { dealerId, expiresAt: link.expiresAt.toISOString(), sessionsEnded: true, passwordCleared: true },
    }, tx)
    return { kind: "issued" as const, ...link }
  })
}

const INVALID_LINK = "This link is invalid or has expired. Ask for a new one."

/** The public set-password step. `tenantId` is the lender the dealer host resolves. */
export async function setDealerPassword(
  input: { tenantId: string; token: unknown; password: unknown },
  now: Date = new Date(),
): Promise<{ kind: "set" } | DealerRefusal> {
  if (typeof input.token !== "string" || !/^[0-9a-f]{64}$/.test(input.token)) return dealerRefused(400, INVALID_LINK)
  if (typeof input.password !== "string") return dealerRefused(400, "A password is required")
  const policy = passwordPolicyError(input.password)
  if (policy) return dealerRefused(400, policy)
  const tokenHash = hashDealerToken(input.token)
  const user = await withoutTenantScope(async () => {
    return await prisma.dealerUser.findUnique({
      where: { setPasswordTokenHash: tokenHash },
      select: { id: true, tenantId: true, dealerId: true, email: true, active: true, setPasswordTokenExp: true },
    })
  })
  if (!user || user.tenantId !== input.tenantId || !user.active || !user.setPasswordTokenExp || user.setPasswordTokenExp <= now) {
    return dealerRefused(400, INVALID_LINK)
  }
  const passwordHash = await bcrypt.hash(input.password, 12)
  return runWithTenant(user.tenantId, () => prisma.$transaction(async (tx) => {
    // Single use: only the row still holding this token is written.
    const written = await tx.dealerUser.updateMany({
      where: { id: user.id, tenantId: user.tenantId, setPasswordTokenHash: tokenHash, active: true },
      data: { passwordHash, setPasswordTokenHash: null, setPasswordTokenExp: null, tokenVersion: { increment: 1 } },
    })
    if (written.count !== 1) return dealerRefused(400, INVALID_LINK)
    const audit = dealerAuditFields({ dealerId: user.dealerId, dealerUserId: user.id, email: user.email })
    await logAuditStrict({
      tenantId: user.tenantId, userId: audit.userId, userEmail: audit.userEmail,
      action: AuditAction.DEALER_USER_PASSWORD_SET, entity: "DealerUser", entityId: user.id,
      newValue: { actor: audit.actor },
    }, tx)
    return { kind: "set" as const }
  }))
}
