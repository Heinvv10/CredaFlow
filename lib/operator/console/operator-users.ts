/**
 * The operator's own staff (OPERATOR_ADMIN only manages them): invite,
 * deactivate, send a new set-password link. Operator users hold no tenant,
 * so these audit rows carry no tenantId; the operator is on the row.
 */
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { OPERATOR_ROLES } from "../roles"
import type { OperatorPrincipal } from "../console-auth"
import {
  INVITE_LINK_HOURS, issueAccountToken, operatorPasswordUrl, RESET_LINK_HOURS, sendAccountLink, unusablePasswordHash,
} from "./account-links"

export type OperatorUserResult<T = object> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409 | 422; error: string }

export function listOperatorUsers(operatorId: string) {
  return prisma.user.findMany({
    where: { operatorId },
    select: { id: true, name: true, email: true, role: true, active: true, totpEnabled: true, lastLoginAt: true, createdAt: true },
    orderBy: [{ active: "desc" }, { email: "asc" }],
  })
}

const inviteSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(OPERATOR_ROLES),
})

async function operatorName(operatorId: string): Promise<string> {
  const op = await prisma.operator.findUnique({ where: { id: operatorId }, select: { name: true } })
  return op?.name ?? "Operator console"
}

export async function inviteOperatorUser(principal: OperatorPrincipal, body: unknown, ipAddress?: string): Promise<OperatorUserResult<{ userId: string; emailSent: boolean }>> {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const parsed = inviteSchema.safeParse({ ...raw, email: typeof raw.email === "string" ? raw.email.trim().toLowerCase() : raw.email })
  if (!parsed.success) return { ok: false, status: 422, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
  const { email, name, role } = parsed.data

  let created: { userId: string; token: string }
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, role, operatorId: principal.operatorId, active: true, password: await unusablePasswordHash() },
        select: { id: true },
      })
      await logAuditStrict({
        userId: principal.id, userEmail: principal.email, action: AuditAction.OPERATOR_USER_INVITED,
        entity: "User", entityId: user.id,
        newValue: { email, role, operatorId: principal.operatorId, expiresInHours: INVITE_LINK_HOURS }, ipAddress,
      }, tx)
      return { userId: user.id, token: await issueAccountToken(tx, user.id, INVITE_LINK_HOURS) }
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, status: 409, error: "A user with this email already exists" }
    }
    throw err
  }
  const emailSent = await sendAccountLink({
    to: email, name, kind: "invite", organisation: await operatorName(principal.operatorId),
    url: () => operatorPasswordUrl(created.token), hours: INVITE_LINK_HOURS,
  })
  return { ok: true, userId: created.userId, emailSent }
}

/** Deactivates and signs out (tokenVersion) one of the operator's users. Never oneself. */
export async function deactivateOperatorUser(principal: OperatorPrincipal, userId: string, ipAddress?: string): Promise<OperatorUserResult> {
  if (userId === principal.id) return { ok: false, status: 409, error: "You cannot deactivate your own account" }
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId, operatorId: principal.operatorId, active: true },
      data: { active: false, resetToken: null, resetTokenExp: null, tokenVersion: { increment: 1 } },
    })
    if (count !== 1) return { ok: false as const, status: 404 as const, error: "No active user of this operator with that id" }
    await logAuditStrict({
      userId: principal.id, userEmail: principal.email, action: AuditAction.OPERATOR_USER_DEACTIVATED,
      entity: "User", entityId: userId, oldValue: { active: true }, newValue: { active: false, operatorId: principal.operatorId }, ipAddress,
    }, tx)
    return { ok: true as const }
  })
}

/** A fresh set-password link for an active operator user (a lost password; never shown to the admin). */
export async function sendOperatorUserReset(principal: OperatorPrincipal, userId: string, ipAddress?: string): Promise<OperatorUserResult<{ emailSent: boolean }>> {
  const target = await prisma.user.findFirst({
    where: { id: userId, operatorId: principal.operatorId, active: true },
    select: { id: true, email: true, name: true },
  })
  if (!target) return { ok: false, status: 404, error: "No active user of this operator with that id" }
  const token = await prisma.$transaction(async (tx) => {
    const issued = await issueAccountToken(tx, target.id, RESET_LINK_HOURS)
    await logAuditStrict({
      userId: principal.id, userEmail: principal.email, action: AuditAction.OPERATOR_USER_RESET_LINK_SENT,
      entity: "User", entityId: target.id, newValue: { targetEmail: target.email, expiresInHours: RESET_LINK_HOURS }, ipAddress,
    }, tx)
    return issued
  })
  const emailSent = await sendAccountLink({
    to: target.email, name: target.name, kind: "reset", organisation: await operatorName(principal.operatorId),
    url: () => operatorPasswordUrl(token), hours: RESET_LINK_HOURS,
  })
  return { ok: true, emailSent }
}
