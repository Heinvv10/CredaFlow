/**
 * The one definition of an AuditChainLink's hash, for the chainer that writes it
 * and the verifier that checks it.
 *
 * rowHash = HMAC-SHA256(AUDIT_CHAIN_KEY, canonical JSON of the link position, the
 * previous hash and the row). The key lives outside the database, so someone with
 * only database access cannot recompute a chain after editing it. The row enters
 * as digests of its personal-data columns, not their text: audit_log_redact()
 * (migration 20261029100000) can null the text and keep the digests in
 * AuditRedaction, and the link still verifies.
 */
import { createHmac } from "node:crypto"
import { Prisma } from "@prisma/client"

export const GENESIS_HASH = "0".repeat(64)
/** The chain key of AuditLog rows that have no tenant. */
export const PLATFORM_CHAIN = ""
const MIN_KEY_LENGTH = 32

export class AuditChainKeyError extends Error {
  constructor() {
    super(`AUDIT_CHAIN_KEY must be set to at least ${MIN_KEY_LENGTH} characters (the audit hash chain is keyed outside the database)`)
    this.name = "AuditChainKeyError"
  }
}

function key(): Buffer {
  const value = process.env.AUDIT_CHAIN_KEY
  if (!value || value.length < MIN_KEY_LENGTH) throw new AuditChainKeyError()
  return Buffer.from(value, "utf8")
}

export function auditChainKeyConfigured(): boolean {
  return (process.env.AUDIT_CHAIN_KEY ?? "").length >= MIN_KEY_LENGTH
}

/** What a link hashes of its AuditLog row: ids, timestamp and digests ("-" for a NULL column). */
export interface HashedRow {
  auditLogId: string
  tenantId: string | null
  userId: string | null
  action: string
  entity: string
  entityId: string | null
  /** "YYYY-MM-DDTHH:MI:SS.MS", as ROW_FIELDS_SQL prints it. */
  createdAt: string
  userEmailDigest: string
  ipAddressDigest: string
  oldValueDigest: string
  newValueDigest: string
}

export function linkHash(chainKey: string, seq: number, prevHash: string, r: HashedRow): string {
  const canonical = JSON.stringify([
    "v2", chainKey, seq, prevHash, r.auditLogId, r.tenantId, r.userId, r.action, r.entity, r.entityId, r.createdAt,
    r.userEmailDigest, r.ipAddressDigest, r.oldValueDigest, r.newValueDigest,
  ])
  return createHmac("sha256", key()).update(canonical).digest("hex")
}

export function checkpointHmac(chainKey: string, seq: number, rowHash: string): string {
  return createHmac("sha256", key()).update(JSON.stringify(["cp1", chainKey, seq, rowHash])).digest("hex")
}

const digest = (column: string, redacted: string) => `COALESCE(
    (SELECT r."${redacted}" FROM "AuditRedaction" r WHERE r."auditLogId" = a."id" AND '${column}' = ANY(r."columns") LIMIT 1),
    encode(sha256(convert_to(a."${column}"${column.endsWith("Value") ? "::text" : ""}, 'UTF8')), 'hex'),
    '-')`

/**
 * The SELECT list that yields a HashedRow from "AuditLog" aliased `a`. A column a
 * redaction removed hashes as the digest the redaction kept.
 */
export const ROW_FIELDS_SQL = Prisma.raw(`
    a."id" AS "auditLogId", a."tenantId", a."userId", a."action", a."entity", a."entityId",
    to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "createdAt",
    ${digest("userEmail", "userEmailDigest")} AS "userEmailDigest",
    ${digest("ipAddress", "ipAddressDigest")} AS "ipAddressDigest",
    ${digest("oldValue", "oldValueDigest")} AS "oldValueDigest",
    ${digest("newValue", "newValueDigest")} AS "newValueDigest"`)

/** The WHERE fragment selecting one chain's AuditLog rows (alias `a`). */
export function chainRows(chainKey: string): Prisma.Sql {
  return chainKey === PLATFORM_CHAIN ? Prisma.sql`a."tenantId" IS NULL` : Prisma.sql`a."tenantId" = ${chainKey}`
}
