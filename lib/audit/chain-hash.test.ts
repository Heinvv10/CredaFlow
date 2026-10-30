import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AuditChainKeyError, checkpointHmac, columnDigest, columnDigestOfSha, GENESIS_HASH, linkHash, repairHmac, sha256Hex, type RowInputs } from "./chain-hash"

const row: RowInputs = {
  auditLogId: "a1", tenantId: "t1", userId: "u1", actionSha: sha256Hex("X"), entitySha: sha256Hex("E"), entityIdSha: sha256Hex("e1"), createdAt: "2026-10-29T12:00:00.123",
  userEmailSha: sha256Hex("p@it.invalid"), ipAddressSha: sha256Hex("10.0.0.1"), oldValueSha: sha256Hex('{"n": 1}'), newValueSha: sha256Hex('{"n": 2}'),
  userEmailRed: null, ipAddressRed: null, oldValueRed: null, newValueRed: null,
}
const KEY = "k".repeat(40)

beforeEach(() => { process.env.AUDIT_CHAIN_KEY = KEY })
afterEach(() => { delete process.env.AUDIT_CHAIN_KEY })

describe("link hash", () => {
  it("is deterministic and depends on every input, each hashed column included", () => {
    const base = linkHash("t1", 1, GENESIS_HASH, row)
    expect(linkHash("t1", 1, GENESIS_HASH, row)).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    for (const changed of [
      linkHash("t2", 1, GENESIS_HASH, row), linkHash("t1", 2, GENESIS_HASH, row), linkHash("t1", 1, "1".repeat(64), row),
      linkHash("t1", 1, GENESIS_HASH, { ...row, actionSha: sha256Hex("Y") }), linkHash("t1", 1, GENESIS_HASH, { ...row, entitySha: sha256Hex("F") }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, entityIdSha: sha256Hex("e2") }), linkHash("t1", 1, GENESIS_HASH, { ...row, entityIdSha: null }), linkHash("t1", 1, GENESIS_HASH, { ...row, tenantId: null }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, userEmailSha: sha256Hex("q@it.invalid") }), linkHash("t1", 1, GENESIS_HASH, { ...row, ipAddressSha: sha256Hex("10.0.0.2") }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, oldValueSha: sha256Hex('{"n": 3}') }), linkHash("t1", 1, GENESIS_HASH, { ...row, newValueSha: null }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, createdAt: "2026-10-29T12:00:00.124" }),
    ]) expect(changed).not.toBe(base)
  })

  it("is the same after a redaction that kept the keyed digest, and different if the digest is not the value's", () => {
    const base = linkHash("t1", 1, GENESIS_HASH, row)
    const redacted = { ...row, userEmailSha: null, userEmailRed: columnDigest("userEmail", "p@it.invalid") }
    expect(linkHash("t1", 1, GENESIS_HASH, redacted)).toBe(base)
    expect(linkHash("t1", 1, GENESIS_HASH, { ...redacted, userEmailRed: columnDigest("userEmail", "someone@else.invalid") })).not.toBe(base)
  })

  it("derives a column's digest from its SHA-256 or from the value alike, so the database can hash a huge value for the worker", () => {
    expect(columnDigestOfSha("oldValue", sha256Hex('{"n": 1}'))).toBe(columnDigest("oldValue", '{"n": 1}'))
    expect(columnDigestOfSha("oldValue", null)).toBe("-")
  })

  it("keys each digest: another key, another column label or another value gives another digest", () => {
    const d = columnDigest("userEmail", "p@it.invalid")
    expect(d).toMatch(/^[0-9a-f]{64}$/)
    expect(columnDigest("ipAddress", "p@it.invalid")).not.toBe(d)
    expect(columnDigest("userEmail", null)).toBe("-")
    process.env.AUDIT_CHAIN_KEY = "z".repeat(40)
    expect(columnDigest("userEmail", "p@it.invalid")).not.toBe(d)
  })

  it("is keyed: another key gives another hash, and no key refuses to hash", () => {
    const a = linkHash("t1", 1, GENESIS_HASH, row)
    process.env.AUDIT_CHAIN_KEY = "z".repeat(40)
    expect(linkHash("t1", 1, GENESIS_HASH, row)).not.toBe(a)
    process.env.AUDIT_CHAIN_KEY = "short"
    expect(() => linkHash("t1", 1, GENESIS_HASH, row)).toThrow(AuditChainKeyError)
    delete process.env.AUDIT_CHAIN_KEY
    expect(() => checkpointHmac("t1", 1, GENESIS_HASH)).toThrow(AuditChainKeyError)
    expect(() => repairHmac({ chainKey: "t1", seq: 1, kind: "seq_gap", auditLogId: "", linkRowHash: "", observedHash: "" }, "a reason here", "op")).toThrow(AuditChainKeyError)
  })

  it("signs a repair over the chain, place, kind, audit row, link hash, observed hash, reason and operator", () => {
    const subject = { chainKey: "t1", seq: 4, kind: "row_hash_mismatch", auditLogId: "a1", linkRowHash: "1".repeat(64), observedHash: "2".repeat(64) }
    const base = repairHmac(subject, "restored from backup 12", "op")
    for (const changed of [
      repairHmac({ ...subject, chainKey: "t2" }, "restored from backup 12", "op"), repairHmac({ ...subject, seq: 5 }, "restored from backup 12", "op"),
      repairHmac({ ...subject, kind: "row_missing" }, "restored from backup 12", "op"), repairHmac({ ...subject, auditLogId: "a2" }, "restored from backup 12", "op"),
      repairHmac({ ...subject, linkRowHash: "3".repeat(64) }, "restored from backup 12", "op"), repairHmac({ ...subject, observedHash: "4".repeat(64) }, "restored from backup 12", "op"),
      repairHmac(subject, "restored from backup 13", "op"), repairHmac(subject, "restored from backup 12", "other"),
    ]) expect(changed).not.toBe(base)
  })
})
