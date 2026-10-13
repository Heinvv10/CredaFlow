/**
 * The first SUPER_ADMIN of a lender, and the break-glass reset of a locked-out
 * one. Unlike prisma/seed.ts it is safe under NODE_ENV=production: it creates
 * exactly one staff row and no demo data.
 *
 * Bootstrap is one-shot: it refuses when the tenant has any SUPER_ADMIN (active
 * or not), so a stale runbook cannot mint a second one. Recovery from a lockout
 * is the same CLI with an explicit break-glass mode, which only ever resets an
 * EXISTING SUPER_ADMIN of the tenant. Both modes write a one-time password and a
 * fresh TOTP secret (staff 2FA is mandatory, and identity/user writes need a
 * TOTP-verified session), return them to the caller to print once, and audit
 * the event without any credential in the audit row.
 */
import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { z } from "zod"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditDb } from "./audit-db"
import { generateTotpSecret, generateTotpUri } from "@/lib/totp"

export type AdminMode = "bootstrap" | "break-glass"

export type AdminBootstrapInput = {
  tenantSlug: string
  email: string
  name?: string
  mode: AdminMode
  dryRun: boolean
  /** Who ran the CLI (OS user @ host), recorded in the audit row. */
  operator: string
}

export type AdminBootstrapResult =
  | { kind: "dry-run"; action: "create" | "break-glass"; tenantSlug: string; email: string }
  | { kind: "created" | "reset"; userId: string; email: string; password: string; totpSecret: string; otpauthUri: string }

export type RefusalCode =
  | "INVALID_EMAIL"
  | "TENANT_NOT_FOUND"
  | "SUPER_ADMIN_EXISTS"
  | "EMAIL_IN_USE"
  | "NO_SUCH_SUPER_ADMIN"

export class BootstrapRefusal extends Error {
  readonly code: RefusalCode
  constructor(code: RefusalCode, message: string) {
    super(message)
    this.name = "BootstrapRefusal"
    this.code = code
  }
}

const BCRYPT_ROUNDS = 12
const SOURCE = "lender:bootstrap-admin"

/** 24 URL-safe characters (144 bits). Printed once; only its bcrypt hash is stored. */
export const generateOneTimePassword = () => randomBytes(18).toString("base64url")

export async function bootstrapSuperAdmin(db: PrismaClient, input: AdminBootstrapInput): Promise<AdminBootstrapResult> {
  const parsed = z.email().max(254).safeParse(input.email.trim().toLowerCase())
  if (!parsed.success) throw new BootstrapRefusal("INVALID_EMAIL", `"${input.email}" is not a valid email address.`)
  const email = parsed.data

  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { slug: input.tenantSlug },
      select: { id: true, name: true, config: { select: { brandName: true } } },
    })
    if (!tenant) throw new BootstrapRefusal("TENANT_NOT_FOUND", `No tenant with slug "${input.tenantSlug}". Run lender:bootstrap-tenant first.`)

    // Serialise concurrent runs on the tenant row: without the lock two
    // simultaneous bootstraps both see zero SUPER_ADMINs and both create one.
    await tx.$executeRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${tenant.id} FOR UPDATE`

    const existing = await tx.user.findUnique({ where: { email } })
    const issuer = tenant.config?.brandName?.trim() || tenant.name
    const base = { tenantSlug: input.tenantSlug, email }

    if (input.mode === "bootstrap") {
      const superAdmins = await tx.user.count({ where: { tenantId: tenant.id, role: "SUPER_ADMIN" } })
      if (superAdmins > 0) {
        throw new BootstrapRefusal(
          "SUPER_ADMIN_EXISTS",
          `Tenant "${input.tenantSlug}" already has ${superAdmins} SUPER_ADMIN(s); bootstrap is one-shot. If the only one is locked out, rerun with --break-glass --email <their email>.`,
        )
      }
      if (existing) throw new BootstrapRefusal("EMAIL_IN_USE", `A user with email ${email} already exists.`)
      if (input.dryRun) return { kind: "dry-run", action: "create", ...base }

      const secrets = await newCredentials(email, issuer)
      const user = await tx.user.create({
        data: {
          email, name: input.name ?? "Super Admin", role: "SUPER_ADMIN", tenantId: tenant.id, active: true,
          password: secrets.hash, totpSecret: secrets.totpSecret, totpEnabled: true,
        },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userEmail: SOURCE,
        action: AuditAction.SUPER_ADMIN_BOOTSTRAPPED,
        entity: "User",
        entityId: user.id,
        newValue: { email, role: "SUPER_ADMIN", totpEnrolled: true, operator: input.operator },
      }, auditDb(tx))
      return { kind: "created", userId: user.id, email, ...secrets.shown }
    }

    // Break-glass: only ever an existing SUPER_ADMIN of this tenant.
    if (!existing || existing.role !== "SUPER_ADMIN" || existing.tenantId !== tenant.id) {
      throw new BootstrapRefusal("NO_SUCH_SUPER_ADMIN", `${email} is not a SUPER_ADMIN of tenant "${input.tenantSlug}"; break-glass never creates or promotes a user.`)
    }
    if (input.dryRun) return { kind: "dry-run", action: "break-glass", ...base }

    const before = { active: existing.active, totpEnabled: existing.totpEnabled }
    const secrets = await newCredentials(email, issuer)
    await tx.user.update({
      where: { id: existing.id },
      data: {
        password: secrets.hash, totpSecret: secrets.totpSecret, totpEnabled: true, lastTotpCounter: null,
        active: true, resetToken: null, resetTokenExp: null,
        // Ends every session issued before the reset (lib/auth.ts revalidatePrincipal).
        tokenVersion: { increment: 1 },
      },
    })
    await logAuditStrict({
      tenantId: tenant.id,
      userEmail: SOURCE,
      action: AuditAction.SUPER_ADMIN_BREAK_GLASS_RESET,
      entity: "User",
      entityId: existing.id,
      oldValue: before,
      newValue: { email, active: true, passwordReset: true, totpReset: true, sessionsRevoked: true, operator: input.operator },
    }, auditDb(tx))
    return { kind: "reset", userId: existing.id, email, ...secrets.shown }
  })
}

async function newCredentials(email: string, issuer: string) {
  const password = generateOneTimePassword()
  const totpSecret = generateTotpSecret()
  return {
    hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    totpSecret,
    shown: { password, totpSecret, otpauthUri: generateTotpUri(email, totpSecret, issuer) },
  }
}
