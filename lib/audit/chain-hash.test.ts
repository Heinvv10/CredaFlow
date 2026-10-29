import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AuditChainKeyError, checkpointHmac, columnDigest, GENESIS_HASH, linkHash, repairHmac, type RowInputs } from "./chain-hash"

const row: RowInputs = {
  auditLogId: "a1", tenantId: "t1", userId: "u1", action: "X", entity: "E", entityId: "e1", createdAt: "2026-10-29T12:00:00.123",
  userEmail: "p@it.invalid", ipAddress: "10.0.0.1", oldValueText: '{"n": 1}', newValueText: '{"n": 2}',
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
      linkHash("t1", 1, GENESIS_HASH, { ...row, action: "Y" }), linkHash("t1", 1, GENESIS_HASH, { ...row, tenantId: null }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, userEmail: "q@it.invalid" }), linkHash("t1", 1, GENESIS_HASH, { ...row, ipAddress: "10.0.0.2" }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, oldValueText: '{"n": 3}' }), linkHash("t1", 1, GENESIS_HASH, { ...row, newValueText: null }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, createdAt: "2026-10-29T12:00:00.124" }),
    ]) expect(changed).not.toBe(base)
  })

  it("is the same after a redaction that kept the keyed digest, and different if the digest is not the value's", () => {
    const base = linkHash("t1", 1, GENESIS_HASH, row)
    const redacted = { ...row, userEmail: null, userEmailRed: columnDigest("userEmail", "p@it.invalid") }
    expect(linkHash("t1", 1, GENESIS_HASH, redacted)).toBe(base)
    expect(linkHash("t1", 1, GENESIS_HASH, { ...redacted, userEmailRed: columnDigest("userEmail", "someone@else.invalid") })).not.toBe(base)
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
    expect(() => repairHmac("t1", 1, "row_hash_mismatch", "a reason here", "op")).toThrow(AuditChainKeyError)
  })

  it("signs a repair over the chain, seq, kind, reason and operator", () => {
    const base = repairHmac("t1", 4, "seq_gap", "restored from backup 12", "op")
    for (const changed of [repairHmac("t2", 4, "seq_gap", "restored from backup 12", "op"), repairHmac("t1", 5, "seq_gap", "restored from backup 12", "op"),
      repairHmac("t1", 4, "row_missing", "restored from backup 12", "op"), repairHmac("t1", 4, "seq_gap", "restored from backup 13", "op"), repairHmac("t1", 4, "seq_gap", "restored from backup 12", "other")]) expect(changed).not.toBe(base)
  })
})
