import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { LoadedConnection } from "./connection"
import { isMappableRole, roleFromGroups } from "./groups"

/**
 * Who the identity provider says is signing in, mapped to a staff user of THIS
 * lender. The match is by email only. The provider can never create or change
 * a SUPER_ADMIN (the role is neither mappable nor a provisioning default), and
 * creating users on first sign-in is off unless the lender switched it on.
 * Whether the user may actually sign in (active, suspended lender, working
 * hours, second factor) is decided afterwards, in authorizeSso.
 */

export interface IdpIdentity {
  email: string
  /** The provider's own claim; only an explicit false refuses. */
  emailVerified?: boolean
  name?: string | null
  groups: string[]
  mfaProven: boolean
}

export type ResolveRefusal = "no_account" | "email_unverified" | "domain_not_allowed"

export type ResolveOutcome =
  | { ok: true; userId: string; created: boolean; roleChanged?: { from: string; to: string } }
  | { ok: false; reason: ResolveRefusal }

const noAccount = { ok: false, reason: "no_account" } as const

export async function resolveStaffUser(identity: IdpIdentity, conn: LoadedConnection): Promise<ResolveOutcome> {
  const email = identity.email.trim().toLowerCase()
  if (!email.includes("@")) return noAccount
  if (identity.emailVerified === false) return { ok: false, reason: "email_unverified" }
  const domain = email.slice(email.lastIndexOf("@") + 1)
  if (conn.allowedEmailDomains.length > 0 && !conn.allowedEmailDomains.includes(domain)) return { ok: false, reason: "domain_not_allowed" }

  const mapped = roleFromGroups(identity.groups, conn.groupRoleMap)
  const tenantId = conn.tenantId
  const source = { source: "sso" }

  const attempt = () => prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email } })
    if (user) {
      if (user.tenantId !== tenantId || user.operatorId) return noAccount
      if (mapped && user.role !== "SUPER_ADMIN" && user.role !== mapped) {
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
    const role = mapped ?? conn.jitDefaultRole
    if (!conn.jitProvisioning || !isMappableRole(role)) return noAccount
    // No password anyone knows: the account signs in through the provider (or a Super Admin sets one).
    const password = await bcrypt.hash(randomBytes(32).toString("hex"), 12)
    const created = await tx.user.create({
      data: { email, name: identity.name?.trim() || email.slice(0, email.lastIndexOf("@")), password, role, tenantId, active: true },
    })
    await logAuditStrict({
      tenantId, userId: created.id, userEmail: email, action: AuditAction.SSO_USER_PROVISIONED, entity: "User", entityId: created.id,
      newValue: { role, ...source },
    }, tx)
    return { ok: true, userId: created.id, created: true } as const
  })

  try {
    return await attempt()
  } catch (error) {
    if ((error as { code?: unknown }).code !== "P2002") throw error
    // Two first sign-ins at once: the other one created the row.
    return attempt()
  }
}
