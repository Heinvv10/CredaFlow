/**
 * The one definition of an AuditChainLink's hash, for the chainer that writes it
 * and the verifier that checks it.
 *
 * rowHash = HMAC-SHA256(AUDIT_CHAIN_KEY, canonical JSON of the link position, the
 * previous hash and the row). The key lives outside the database (only the worker
 * holds it), so someone with only database access cannot recompute a chain after
 * editing it. The row enters as KEYED digests of its personal-data columns, not
 * their text: audit_log_redact() (migration 20261029100000) can null the text and
 * keep the operator-computed keyed digest in AuditRedaction, and the link still
 * verifies; the database never holds an unkeyed digest of an email or an address.
 */
import { createHmac } from "node:crypto"

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

/**
 * What the database hands the worker for an AuditLog row (audit_hash_inputs): the ids and time,
 * and the raw personal-data columns (jsonb as canonical text), plus, for a column a documented
 * redaction removed, the keyed digest the redaction kept.
 */
export interface RowInputs {
  auditLogId: string
  tenantId: string | null
  userId: string | null
  action: string
  entity: string
  entityId: string | null
  /** "YYYY-MM-DDTHH:MI:SS.MS" (UTC), as audit_hash_inputs prints it. */
  createdAt: string
  userEmail: string | null
  ipAddress: string | null
  oldValueText: string | null
  newValueText: string | null
  userEmailRed: string | null
  ipAddressRed: string | null
  oldValueRed: string | null
  newValueRed: string | null
}

export const HASHED_COLUMNS = ["userEmail", "ipAddress", "oldValue", "newValue"] as const
export type HashedColumn = (typeof HASHED_COLUMNS)[number]

/**
 * The keyed digest of one personal-data column: HMAC(AUDIT_CHAIN_KEY, label + value), "-" for NULL.
 * Keyed so the database (which holds the digest of a redacted column for good) cannot be used to
 * test guesses of an email, an address or a value; only the key holder can.
 */
export function columnDigest(column: HashedColumn, value: string | null): string {
  if (value === null) return "-"
  return createHmac("sha256", key()).update(`d1|${column}|${value}`).digest("hex")
}

/** What a link hashes of a column: the digest a redaction kept, else the keyed digest of the value. */
function digestOf(column: HashedColumn, value: string | null, redacted: string | null): string {
  return redacted ?? columnDigest(column, value)
}

export function linkHash(chainKey: string, seq: number, prevHash: string, r: RowInputs): string {
  const canonical = JSON.stringify([
    "v3", chainKey, seq, prevHash, r.auditLogId, r.tenantId, r.userId, r.action, r.entity, r.entityId, r.createdAt,
    digestOf("userEmail", r.userEmail, r.userEmailRed), digestOf("ipAddress", r.ipAddress, r.ipAddressRed),
    digestOf("oldValue", r.oldValueText, r.oldValueRed), digestOf("newValue", r.newValueText, r.newValueRed),
  ])
  return createHmac("sha256", key()).update(canonical).digest("hex")
}

export function checkpointHmac(chainKey: string, seq: number, rowHash: string): string {
  return createHmac("sha256", key()).update(JSON.stringify(["cp1", chainKey, seq, rowHash])).digest("hex")
}

/** The signature of an operator's acceptance of a break (audit_chain_accept_break). */
export function repairHmac(chainKey: string, seq: number, kind: string, reason: string, operator: string): string {
  return createHmac("sha256", key()).update(JSON.stringify(["rp1", chainKey, seq, kind, reason.trim(), operator.trim()])).digest("hex")
}
