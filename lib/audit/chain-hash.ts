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
import { createHash, createHmac } from "node:crypto"

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
 * What the database hands the worker for an AuditLog row (audit_hash_inputs): the ids and time, the
 * SHA-256 of each personal-data column (jsonb as canonical text; NULL for a NULL column; computed in the
 * database so a row with a huge value costs the worker nothing to receive), and, for a column a
 * documented redaction removed, the keyed digest the redaction kept.
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
  userEmailSha: string | null
  ipAddressSha: string | null
  oldValueSha: string | null
  newValueSha: string | null
  userEmailRed: string | null
  ipAddressRed: string | null
  oldValueRed: string | null
  newValueRed: string | null
}

export const HASHED_COLUMNS = ["userEmail", "ipAddress", "oldValue", "newValue"] as const
export type HashedColumn = (typeof HASHED_COLUMNS)[number]

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

/**
 * The keyed digest of one personal-data column given the SHA-256 of its value ("-" for NULL):
 * HMAC(AUDIT_CHAIN_KEY, label + sha). Keyed so the database (which holds the digest of a redacted
 * column for good) cannot be used to test guesses of an email, an address or a value; only the key
 * holder can.
 */
export function columnDigestOfSha(column: HashedColumn, sha: string | null): string {
  if (sha === null) return "-"
  return createHmac("sha256", key()).update(`d1|${column}|${sha}`).digest("hex")
}

/** The same from the value itself (what the redaction tool, which reads the value, computes). */
export function columnDigest(column: HashedColumn, value: string | null): string {
  return columnDigestOfSha(column, value === null ? null : sha256Hex(value))
}

/** What a link hashes of a column: the digest a redaction kept, else the keyed digest of the value. */
function digestOf(column: HashedColumn, sha: string | null, redacted: string | null): string {
  return redacted ?? columnDigestOfSha(column, sha)
}

export function linkHash(chainKey: string, seq: number, prevHash: string, r: RowInputs): string {
  const canonical = JSON.stringify([
    "v3", chainKey, seq, prevHash, r.auditLogId, r.tenantId, r.userId, r.action, r.entity, r.entityId, r.createdAt,
    digestOf("userEmail", r.userEmailSha, r.userEmailRed), digestOf("ipAddress", r.ipAddressSha, r.ipAddressRed),
    digestOf("oldValue", r.oldValueSha, r.oldValueRed), digestOf("newValue", r.newValueSha, r.newValueRed),
  ])
  return createHmac("sha256", key()).update(canonical).digest("hex")
}

export function checkpointHmac(chainKey: string, seq: number, rowHash: string): string {
  return createHmac("sha256", key()).update(JSON.stringify(["cp1", chainKey, seq, rowHash])).digest("hex")
}

/**
 * The signature of an operator's acceptance of ONE break (audit_chain_accept_break): the chain, the link's
 * position and kind, the audit row and the link's hash it was seen on, and, for a content mismatch, the hash
 * the row recomputes to (the state the operator accepted), then the reason and who. Anything else about
 * that place changing later makes the break a new one.
 */
export interface RepairSubject {
  chainKey: string
  seq: number
  kind: string
  auditLogId: string
  linkRowHash: string
  observedHash: string
}

export function repairHmac(r: RepairSubject, reason: string, operator: string): string {
  return createHmac("sha256", key())
    .update(JSON.stringify(["rp2", r.chainKey, r.seq, r.kind, r.auditLogId, r.linkRowHash, r.observedHash, reason.trim(), operator.trim()]))
    .digest("hex")
}
