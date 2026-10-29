import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { LoadedConnection } from "./connection"
import { isMappableRole, roleFromGroups } from "./groups"

/**
 * Who the identity provider says is signing in, mapped to a staff user of THIS
 * lender.
 *
 *  - The email must be verified: `emailVerified === true`. A missing claim is
 *    not a yes, unless the lender opted in (SsoConnection.allowUnverifiedEmail).
 *  - The first sign-in matches the staff user by email and binds the provider's
 *    stable subject to it (SsoIdentity). From then on the subject decides, never
 *    the email, so a re-used or re-pointed address at the provider cannot take
 *    the account. A different subject presenting a bound user's email is refused.
 *  - A SUPER_ADMIN never signs in through the provider: it keeps password plus
 *    CredaFlow TOTP, which is also the break-glass path. The provider cannot
 *    create or change one either (not mappable, not a provisioning default).
 *  - Creating users on first sign-in is off unless the lender switched it on.
 * Whether the user may actually sign in (active, suspended lender, working
 * hours, second factor) is decided afterwards, in authorizeSso.
 */

export interface IdpIdentity {
  /** The provider's stable id for the person: "<issuer>|<sub>" (OIDC) or "<IdP entity id>|<NameID>" (SAML). */
  subject: string
  email: string
  /** The provider's `email_verified`; undefined when it does not say. */
  emailVerified?: boolean
  name?: string | null
  groups: string[]
  mfaProven: boolean
}

export type ResolveRefusal = "no_account" | "email_unverified" | "domain_not_allowed" | "subject_mismatch" | "super_admin_password_only"

export type ResolveOutcome =
  | { ok: true; userId: string; created: boolean; roleChanged?: { from: string; to: string } }
  | { ok: false; reason: ResolveRefusal }

const noAccount = { ok: false, reason: "no_account" } as const

export async function resolveStaffUser(identity: IdpIdentity, conn: LoadedConnection): Promise<ResolveOutcome> {
  const email = identity.email.trim().toLowerCase()
  if (!email.includes("@") || !identity.subject) return noAccount
  if (identity.emailVerified !== true && !conn.allowUnverifiedEmail) return { ok: false, reason: "email_unverified" }
  const domain = email.slice(email.lastIndexOf("@") + 1)
  if (conn.allowedEmailDomains.length > 0 && !conn.allowedEmailDomains.includes(domain)) return { ok: false, reason: "domain_not_allowed" }

  const mapped = roleFromGroups(identity.groups, conn.groupRoleMap)
  const tenantId = conn.tenantId
  const source = { source: "sso" }

  const attempt = () => prisma.$transaction(async (tx) => {
    const bound = await tx.ssoIdentity.findFirst({ where: { tenantId, subject: identity.subject }, select: { userId: true } })
    let user = bound
      ? await tx.user.findUnique({ where: { id: bound.userId } })
      : await tx.user.findUnique({ where: { email } })
    if (user) {
      if (user.tenantId !== tenantId || user.operatorId) return noAccount
      if (user.role === "SUPER_ADMIN") return { ok: false, reason: "super_admin_password_only" } as const
      if (!bound) {
        // First sign-in of this person: the email names the user once, then the subject is bound.
        const already = await tx.ssoIdentity.findFirst({ where: { tenantId, userId: user.id }, select: { id: true } })
        if (already) return { ok: false, reason: "subject_mismatch" } as const
        await tx.ssoIdentity.create({ data: { tenantId, userId: user.id, subject: identity.subject } })
      }
      if (mapped && user.role !== mapped) {
        const from = user.role
        await tx.user.update({ where: { id: user.id }, data: { role: mapped } })
        await logAuditStrict({
          tenantId, userId: user.id, userEmail: user.email, action: AuditAction.SSO_ROLE_SYNCED, entity: "User", entityId: user.id,
          oldValue: { role: from }, newValue: { role: mapped, ...source },
        }, tx)
        return { ok: true, userId: user.id, created: false, roleChanged: { from, to: mapped } } as const
      }
      return { ok: true, userId: user.id, created: false } as const
    }
    if (bound) return noAccount
    const role = mapped ?? conn.jitDefaultRole
    if (!conn.jitProvisioning || !isMappableRole(role)) return noAccount
    // No password anyone knows: the account signs in through the provider (or a Super Admin sets one).
    const password = await bcrypt.hash(randomBytes(32).toString("hex"), 12)
    user = await tx.user.create({
      data: { email, name: identity.name?.trim() || email.slice(0, email.lastIndexOf("@")), password, role, tenantId, active: true },
    })
    await tx.ssoIdentity.create({ data: { tenantId, userId: user.id, subject: identity.subject } })
    await logAuditStrict({
      tenantId, userId: user.id, userEmail: email, action: AuditAction.SSO_USER_PROVISIONED, entity: "User", entityId: user.id,
      newValue: { role, ...source },
    }, tx)
    return { ok: true, userId: user.id, created: true } as const
  })

  try {
    return await attempt()
  } catch (error) {
    if ((error as { code?: unknown }).code !== "P2002") throw error
    // Two first sign-ins at once: the other one created the row or the link.
    return attempt()
  }
}
