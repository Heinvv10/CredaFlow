/**
 * OPERATOR_ADMIN sends one of a lender's ADMIN / SUPER_ADMIN users a password
 * reset link (S-L2, PR #91). The operator reaching into a lender's most
 * privileged accounts is bounded:
 *
 *  - once an hour per admin (audit-backed, so it holds across instances);
 *  - a link the admin asked for themselves in the last 15 minutes is left
 *    alone (replacing it would void the email they are about to open);
 *  - the lender's other active admins are told, by email, where SMTP is set;
 *  - every send and every refusal is audited under the lender.
 *
 * The link goes only to the admin's own address; the operator never sees it.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit, logAuditStrict } from "@/lib/audit"
import { sendEmail as sendPlatformEmail } from "@/lib/email"
import { STAFF_RESET_LINK_MINUTES } from "@/lib/password-reset"
import { escapeHtml } from "@/lib/utils"
import type { OperatorPrincipal } from "../console-auth"
import { issueAccountToken, lenderPasswordUrl, RESET_LINK_HOURS, sendAccountLink } from "./account-links"

const HOUR_MS = 3_600_000
const SELF_SERVICE_GRACE_MS = 15 * 60_000

export type AdminResetResult =
  | { ok: true; emailSent: boolean; adminsNotified: number }
  | { ok: false; status: 400 | 404 | 409 | 429; error: string }

type TxOutcome =
  | { kind: "refused"; status: 404 | 409 | 429; error: string; reason?: string }
  | { kind: "sent"; token: string; target: { email: string; name: string | null }; others: Array<{ email: string; name: string | null }> }

export async function sendLenderAdminReset(input: {
  principal: OperatorPrincipal
  tenantId: string
  userId: unknown
  ipAddress?: string
  now?: Date
}): Promise<AdminResetResult> {
  const { principal, tenantId, ipAddress } = input
  const now = input.now ?? new Date()
  if (typeof input.userId !== "string" || !input.userId) return { ok: false, status: 400, error: "userId is required" }
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, operatorId: principal.operatorId },
    select: { id: true, name: true, domain: true, config: { select: { brandName: true } } },
  })
  if (!tenant) return { ok: false, status: 404, error: "Lender not found" }
  const userId = input.userId
  const audit = { tenantId, userId: principal.id, userEmail: principal.email, entity: "User", entityId: userId, ipAddress }

  const outcome = await prisma.$transaction(async (tx): Promise<TxOutcome> => {
    // Locks the admin's row: two concurrent resets cannot both pass the hourly check.
    const { count } = await tx.user.updateMany({
      where: { id: userId, tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true },
      data: { updatedAt: now },
    })
    if (count !== 1) return { kind: "refused", status: 404, error: "No active admin of this lender with that id" }
    const target = await tx.user.findUniqueOrThrow({
      where: { id: userId }, select: { email: true, name: true, role: true, resetToken: true, resetTokenExp: true },
    })
    const recent = await tx.auditLog.count({
      where: { action: AuditAction.LENDER_ADMIN_RESET_LINK_SENT, entityId: userId, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    })
    if (recent > 0) {
      return { kind: "refused", status: 429, error: "A reset link was sent to this admin in the last hour", reason: "rate_limited" }
    }
    // A pending self-service link (STAFF_RESET_LINK_MINUTES long) issued under 15 minutes ago.
    const issuedAt = target.resetTokenExp ? target.resetTokenExp.getTime() - STAFF_RESET_LINK_MINUTES * 60_000 : null
    if (target.resetToken && issuedAt !== null && target.resetTokenExp! > now && issuedAt > now.getTime() - SELF_SERVICE_GRACE_MS) {
      return {
        kind: "refused", status: 409, reason: "self_service_link_pending",
        error: "This admin asked for a reset link themselves a few minutes ago; it is still valid",
      }
    }
    const others = await tx.user.findMany({
      where: { tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true, id: { not: userId } },
      select: { email: true, name: true },
    })
    const token = await issueAccountToken(tx, userId, RESET_LINK_HOURS, now)
    await logAuditStrict({
      ...audit, action: AuditAction.LENDER_ADMIN_RESET_LINK_SENT,
      newValue: { targetEmail: target.email, targetRole: target.role, expiresInHours: RESET_LINK_HOURS, otherAdminsToNotify: others.length },
    }, tx)
    return { kind: "sent", token, target, others }
  })

  if (outcome.kind === "refused") {
    if (outcome.reason) await logAudit({ ...audit, action: AuditAction.LENDER_ADMIN_RESET_REFUSED, newValue: { reason: outcome.reason } })
    return { ok: false, status: outcome.status, error: outcome.error }
  }
  const organisation = tenant.config?.brandName ?? tenant.name
  const emailSent = await sendAccountLink({
    to: outcome.target.email, name: outcome.target.name, kind: "reset", organisation,
    url: () => lenderPasswordUrl(tenant, outcome.token), hours: RESET_LINK_HOURS,
  })
  let adminsNotified = 0
  for (const other of outcome.others) {
    if (await notifyOtherAdmin(other, outcome.target.email, organisation, principal.email)) adminsNotified++
  }
  return { ok: true, emailSent, adminsNotified }
}

async function notifyOtherAdmin(to: { email: string; name: string | null }, targetEmail: string, organisation: string, operatorEmail: string): Promise<boolean> {
  try {
    const result = await sendPlatformEmail({
      to: to.email,
      subject: `${organisation}: a password reset was sent to another admin`,
      html: `<p>Hi ${escapeHtml(to.name ?? to.email)},</p>` +
        `<p>Your platform operator (${escapeHtml(operatorEmail)}) sent a password reset link to ${escapeHtml(targetEmail)}, ` +
        `an administrator of ${escapeHtml(organisation)}. If you did not expect this, check with them and review your audit log.</p>`,
    })
    return result.ok && !("dev" in result && result.dev)
  } catch (err) {
    console.error("[operator-console] admin notification not sent:", err instanceof Error ? err.message : err)
    return false
  }
}
