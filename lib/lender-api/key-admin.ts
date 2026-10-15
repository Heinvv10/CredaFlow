import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { generateApiKey } from "@/lib/lender-api/keys"
import type { ApiScope } from "@/lib/lender-api/scopes"

/**
 * Creating and revoking a tenant's API keys (Settings → API & webhooks). The
 * key itself is returned once, on creation; the row and the audit trail hold
 * its prefix and SHA-256 only. Each change commits with its audit row.
 */

export const MAX_ACTIVE_KEYS = 20

interface Actor { id: string; email: string; ipAddress?: string }

export type CreateKeyOutcome =
  | { ok: true; key: string; apiKey: { id: string; name: string; prefix: string; scopes: string[]; expiresAt: Date } }
  | { ok: false; status: 409; error: string }

export async function createApiKey(args: {
  tenantId: string
  actor: Actor
  name: string
  scopes: ApiScope[]
  lifetimeDays: number
}): Promise<CreateKeyOutcome> {
  const generated = generateApiKey()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + args.lifetimeDays * 86_400_000)
  return prisma.$transaction(async (tx) => {
    const active = await tx.apiKey.count({ where: { tenantId: args.tenantId, revokedAt: null, expiresAt: { gt: now } } })
    if (active >= MAX_ACTIVE_KEYS) return { ok: false as const, status: 409 as const, error: `At most ${MAX_ACTIVE_KEYS} active API keys.` }
    const apiKey = await tx.apiKey.create({
      data: {
        tenantId: args.tenantId,
        name: args.name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
        scopes: args.scopes,
        createdById: args.actor.id,
        createdAt: now,
        expiresAt,
      },
      select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id,
      userEmail: args.actor.email,
      action: AuditAction.API_KEY_CREATED,
      entity: "ApiKey",
      entityId: apiKey.id,
      newValue: { name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes, expiresAt: expiresAt.toISOString() },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return { ok: true as const, key: generated.key, apiKey }
  })
}

export async function revokeApiKey(args: { tenantId: string; actor: Actor; keyId: string }): Promise<"revoked" | "not_found" | "already_revoked"> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.apiKey.updateMany({
      where: { id: args.keyId, tenantId: args.tenantId, revokedAt: null },
      data: { revokedAt: now, revokedById: args.actor.id },
    })
    if (count === 0) {
      const exists = await tx.apiKey.findFirst({ where: { id: args.keyId, tenantId: args.tenantId }, select: { id: true } })
      return exists ? "already_revoked" : "not_found"
    }
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id,
      userEmail: args.actor.email,
      action: AuditAction.API_KEY_REVOKED,
      entity: "ApiKey",
      entityId: args.keyId,
      newValue: { revokedAt: now.toISOString() },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return "revoked"
  })
}
