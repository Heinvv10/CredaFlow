import { randomBytes } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { hashApiKey } from "@/lib/lender-api/keys"
import type { ApiScope } from "@/lib/lender-api/scopes"

/**
 * OAuth2 client-credentials clients for /api/v1 (Settings → API & webhooks →
 * OAuth clients). Id `cfc_<16 hex>`, secret `cfs_<43 base64url>` shown once; the
 * row keeps SHA-256 of the secret (256 random bits need no slow hash, as for API
 * keys). Each change commits with its audit row, which never holds a secret.
 */

export const MAX_ACTIVE_CLIENTS = 20
const CLIENT_ID = /^cfc_[0-9a-f]{16}$/
const SHA256_HEX = /^[0-9a-fA-F]{64}$/

export const isClientId = (value: string): boolean => CLIENT_ID.test(value)

export function generateClientCredentials(): { clientId: string; secret: string; secretHash: string } {
  const clientId = `cfc_${randomBytes(8).toString("hex")}`
  const secret = `cfs_${randomBytes(32).toString("base64url")}`
  return { clientId, secret, secretHash: hashApiKey(secret) }
}

export type OauthClientState = "active" | "revoked" | "expired"

export function oauthClientState(row: { revokedAt: Date | null; expiresAt: Date }, now: Date = new Date()): OauthClientState {
  if (row.revokedAt) return "revoked"
  if (row.expiresAt.getTime() <= now.getTime()) return "expired"
  return "active"
}

interface Actor { id: string; email: string; ipAddress?: string }

export interface MtlsPin { subjectDn: string | null; certSha256: string | null }

/** A pin from request input, or null when it is malformed. */
export function parseMtlsPin(input: { subjectDn?: unknown; certSha256?: unknown }): MtlsPin | null {
  const dn = typeof input.subjectDn === "string" && input.subjectDn.trim() !== "" ? input.subjectDn.trim() : null
  const sha = typeof input.certSha256 === "string" && input.certSha256.trim() !== "" ? input.certSha256.trim().replace(/:/g, "") : null
  if (input.subjectDn !== undefined && input.subjectDn !== null && input.subjectDn !== "" && (dn === null || dn.length > 512 || !dn.includes("="))) return null
  if (input.certSha256 !== undefined && input.certSha256 !== null && input.certSha256 !== "" && (sha === null || !SHA256_HEX.test(sha))) return null
  if (dn === null && sha === null) return null
  return { subjectDn: dn, certSha256: sha ? sha.toLowerCase() : null }
}

export type CreateClientOutcome =
  | { ok: true; clientId: string; secret: string; client: { id: string; name: string; clientId: string; scopes: string[]; expiresAt: Date; requireMtls: boolean } }
  | { ok: false; status: 409; error: string }

export async function createOauthClient(args: {
  tenantId: string
  actor: Actor
  name: string
  scopes: ApiScope[]
  lifetimeDays: number
  mtls: MtlsPin | null
}): Promise<CreateClientOutcome> {
  const generated = generateClientCredentials()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + args.lifetimeDays * 86_400_000)
  return prisma.$transaction(async (tx) => {
    const active = await tx.oauthClient.count({ where: { tenantId: args.tenantId, revokedAt: null, expiresAt: { gt: now } } })
    if (active >= MAX_ACTIVE_CLIENTS) return { ok: false as const, status: 409 as const, error: `At most ${MAX_ACTIVE_CLIENTS} active OAuth clients.` }
    const client = await tx.oauthClient.create({
      data: {
        tenantId: args.tenantId, name: args.name, clientId: generated.clientId, secretHash: generated.secretHash,
        scopes: args.scopes, createdById: args.actor.id, createdAt: now, expiresAt,
        requireMtls: args.mtls !== null, mtlsSubjectDn: args.mtls?.subjectDn ?? null, mtlsCertSha256: args.mtls?.certSha256 ?? null,
      },
      select: { id: true, name: true, clientId: true, scopes: true, expiresAt: true, requireMtls: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email, action: AuditAction.OAUTH_CLIENT_CREATED,
      entity: "OauthClient", entityId: client.id,
      newValue: {
        name: client.name, clientId: client.clientId, scopes: client.scopes, expiresAt: expiresAt.toISOString(),
        requireMtls: client.requireMtls, mtlsSubjectDn: args.mtls?.subjectDn ?? null, mtlsCertSha256: args.mtls?.certSha256 ?? null,
      },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return { ok: true as const, clientId: generated.clientId, secret: generated.secret, client }
  })
}

export async function revokeOauthClient(args: { tenantId: string; actor: Actor; id: string }): Promise<"revoked" | "not_found" | "already_revoked"> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.oauthClient.updateMany({
      where: { id: args.id, tenantId: args.tenantId, revokedAt: null },
      data: { revokedAt: now, revokedById: args.actor.id },
    })
    if (count === 0) {
      const exists = await tx.oauthClient.findFirst({ where: { id: args.id, tenantId: args.tenantId }, select: { id: true } })
      return exists ? "already_revoked" : "not_found"
    }
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email, action: AuditAction.OAUTH_CLIENT_REVOKED,
      entity: "OauthClient", entityId: args.id, newValue: { revokedAt: now.toISOString() }, ipAddress: args.actor.ipAddress,
    }, tx)
    return "revoked"
  })
}

export async function listOauthClients(tenantId: string) {
  const rows = await prisma.oauthClient.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, name: true, clientId: true, scopes: true, createdAt: true, expiresAt: true, lastUsedAt: true, revokedAt: true,
      requireMtls: true, mtlsSubjectDn: true, mtlsCertSha256: true,
      createdBy: { select: { active: true, role: true } },
    },
  })
  return rows.map((r) => ({ ...r, state: oauthClientState(r) }))
}
