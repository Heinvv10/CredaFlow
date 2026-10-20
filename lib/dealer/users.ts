/**
 * Dealer users and dealer deactivation. Staff (manage_dealers, checked by the
 * route) manage any dealer of their lender; a DEALER_ADMIN (requireDealer
 * { admin: true }) manages its own dealer's users only, never itself. A miss
 * outside the caller's reach is 404.
 *
 * Revocation: deactivating a user bumps its tokenVersion; deactivating a
 * dealer sets it inactive and bumps every one of its users' tokenVersion in
 * the same transaction. lib/dealer/principal.ts ends the sessions on their
 * next request. Rows are never deleted (guardDealer, guardDealerUser).
 */
import { Prisma, type DealerRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dealerAuditFields, type DealerActor, type StaffActor } from "./actor"
import { writeDealerLink } from "./password-links"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export type DealerUserManager = { kind: "staff"; staff: StaffActor } | { kind: "dealer"; actor: DealerActor }

const DEALER_ROLES: readonly DealerRole[] = ["DEALER_ADMIN", "DEALER_SALES"]
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type DealerUserInput = { email: string; name: string; role: DealerRole }

export function parseDealerUserInput(body: unknown): { data: DealerUserInput } | { errors: Record<string, string> } {
  const b = (body ?? {}) as Record<string, unknown>
  const errors: Record<string, string> = {}
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : ""
  const name = typeof b.name === "string" ? b.name.trim() : ""
  if (!EMAIL.test(email) || email.length > 200) errors.email = "A valid email address is required"
  if (name.length < 1 || name.length > 200) errors.name = "A name of 1-200 characters is required"
  if (!DEALER_ROLES.includes(b.role as DealerRole)) errors.role = "role must be DEALER_ADMIN or DEALER_SALES"
  return Object.keys(errors).length > 0 ? { errors } : { data: { email, name, role: b.role as DealerRole } }
}

/** The signed-in dealer user and its dealer, as the portal header shows them; null when the row is gone. */
export async function loadDealerProfile(actor: Pick<DealerActor, "tenantId" | "dealerId" | "dealerUserId">) {
  const user = await prisma.dealerUser.findFirst({
    where: { id: actor.dealerUserId, tenantId: actor.tenantId, dealerId: actor.dealerId },
    select: { id: true, email: true, name: true, role: true, dealer: { select: { name: true, kind: true } } },
  })
  return user
}

/**
 * A dealer's users as its DEALER_ADMIN sees them: never a password hash or a
 * link token, only whether a password is set and whether a link is pending.
 */
export async function listDealerUsers(actor: Pick<DealerActor, "tenantId" | "dealerId">, now: Date = new Date()) {
  const rows = await prisma.dealerUser.findMany({
    where: { tenantId: actor.tenantId, dealerId: actor.dealerId },
    select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true, passwordHash: true, setPasswordTokenExp: true },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  })
  return rows.map(({ passwordHash, setPasswordTokenExp, lastLoginAt, createdAt, ...user }) => ({
    ...user,
    lastLoginAt: lastLoginAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    passwordSet: passwordHash !== null,
    linkPending: setPasswordTokenExp !== null && setPasswordTokenExp > now,
  }))
}

const tenantOf = (by: DealerUserManager) => (by.kind === "staff" ? by.staff.tenantId : by.actor.tenantId)

function auditBy(by: DealerUserManager): { userId?: string; userEmail?: string; actor?: unknown } {
  if (by.kind === "staff") return { userId: by.staff.userId, userEmail: by.staff.userEmail }
  return dealerAuditFields(by.actor)
}

/**
 * A new user of `dealerId` (a dealer admin: always its own dealer) with a
 * one-time set-password link. 409 when the email is already a dealer user of
 * this lender or the dealer is deactivated.
 */
export async function createDealerUser(
  by: DealerUserManager,
  dealerId: string,
  input: DealerUserInput,
): Promise<{ kind: "created"; userId: string; token: string; expiresAt: Date } | DealerRefusal> {
  const tenantId = tenantOf(by)
  if (by.kind === "dealer" && dealerId !== by.actor.dealerId) return dealerMiss("Dealer")
  try {
    return await prisma.$transaction(async (tx) => {
      const dealer = await tx.dealer.findFirst({ where: { id: dealerId, tenantId }, select: { id: true, active: true } })
      if (!dealer) return dealerMiss("Dealer")
      if (!dealer.active) return dealerRefused(409, "The dealer is deactivated")
      const created = await tx.dealerUser.create({
        data: {
          tenantId, dealerId, email: input.email, name: input.name, role: input.role,
          createdByUserId: by.kind === "staff" ? by.staff.userId : null,
          createdByDealerUserId: by.kind === "dealer" ? by.actor.dealerUserId : null,
        },
        select: { id: true },
      })
      const link = await writeDealerLink(tx, tenantId, created.id, { bumpTokenVersion: false })
      const audit = auditBy(by)
      await logAuditStrict({
        tenantId, userId: audit.userId, userEmail: audit.userEmail,
        action: AuditAction.DEALER_USER_CREATED, entity: "DealerUser", entityId: created.id,
        newValue: { dealerId, email: input.email, role: input.role, linkExpiresAt: link.expiresAt.toISOString(), ...(audit.actor ? { actor: audit.actor } : {}) },
      }, tx)
      return { kind: "created" as const, userId: created.id, ...link }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return dealerRefused(409, "That email address is already a dealer user of this lender")
    }
    throw error
  }
}

/** Deactivate one user and end its sessions. A dealer admin cannot deactivate itself. */
export async function deactivateDealerUser(
  by: DealerUserManager,
  dealerId: string,
  dealerUserId: string,
): Promise<{ kind: "deactivated" } | DealerRefusal> {
  const tenantId = tenantOf(by)
  if (by.kind === "dealer" && dealerId !== by.actor.dealerId) return dealerMiss("Dealer user")
  if (by.kind === "dealer" && dealerUserId === by.actor.dealerUserId) return dealerRefused(409, "You cannot deactivate your own user")
  return prisma.$transaction(async (tx) => {
    const user = await tx.dealerUser.findFirst({ where: { id: dealerUserId, tenantId, dealerId }, select: { id: true, active: true } })
    if (!user) return dealerMiss("Dealer user")
    if (!user.active) return dealerRefused(409, "The dealer user is already deactivated")
    await tx.dealerUser.update({
      where: { id: user.id, tenantId },
      data: { active: false, setPasswordTokenHash: null, setPasswordTokenExp: null, tokenVersion: { increment: 1 } },
    })
    const audit = auditBy(by)
    await logAuditStrict({
      tenantId, userId: audit.userId, userEmail: audit.userEmail,
      action: AuditAction.DEALER_USER_DEACTIVATED, entity: "DealerUser", entityId: user.id,
      newValue: { dealerId, sessionsEnded: true, ...(audit.actor ? { actor: audit.actor } : {}) },
    }, tx)
    return { kind: "deactivated" as const }
  })
}

/** Staff only: the dealer can no longer originate, and every one of its users' sessions ends. */
export async function deactivateDealer(staff: StaffActor, dealerId: string): Promise<{ kind: "deactivated"; usersRevoked: number } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const dealer = await tx.dealer.findFirst({ where: { id: dealerId, tenantId: staff.tenantId }, select: { id: true, active: true } })
    if (!dealer) return dealerMiss("Dealer")
    if (!dealer.active) return dealerRefused(409, "The dealer is already deactivated")
    await tx.dealer.update({
      where: { id: dealer.id, tenantId: staff.tenantId },
      data: { active: false, deactivatedAt: new Date(), deactivatedById: staff.userId },
    })
    const revoked = await tx.dealerUser.updateMany({
      where: { tenantId: staff.tenantId, dealerId },
      data: { tokenVersion: { increment: 1 }, setPasswordTokenHash: null, setPasswordTokenExp: null },
    })
    await logAuditStrict({
      tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_DEACTIVATED, entity: "Dealer", entityId: dealer.id,
      newValue: { usersRevoked: revoked.count },
    }, tx)
    return { kind: "deactivated" as const, usersRevoked: revoked.count }
  })
}
