import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AuditChainKeyError, checkpointHmac, GENESIS_HASH, linkHash, type HashedRow } from "./chain-hash"

const row: HashedRow = {
  auditLogId: "a1", tenantId: "t1", userId: "u1", action: "X", entity: "E", entityId: "e1", createdAt: "2026-10-29T12:00:00.123",
  userEmailDigest: "-", ipAddressDigest: "-", oldValueDigest: "-", newValueDigest: "ab".repeat(32),
}
const KEY = "k".repeat(40)

beforeEach(() => { process.env.AUDIT_CHAIN_KEY = KEY })
afterEach(() => { delete process.env.AUDIT_CHAIN_KEY })

describe("link hash", () => {
  it("is deterministic and depends on every input", () => {
    const base = linkHash("t1", 1, GENESIS_HASH, row)
    expect(linkHash("t1", 1, GENESIS_HASH, row)).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    for (const changed of [
      linkHash("t2", 1, GENESIS_HASH, row), linkHash("t1", 2, GENESIS_HASH, row), linkHash("t1", 1, "1".repeat(64), row),
      linkHash("t1", 1, GENESIS_HASH, { ...row, action: "Y" }), linkHash("t1", 1, GENESIS_HASH, { ...row, tenantId: null }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, newValueDigest: "cd".repeat(32) }), linkHash("t1", 1, GENESIS_HASH, { ...row, userEmailDigest: "ef".repeat(32) }),
      linkHash("t1", 1, GENESIS_HASH, { ...row, createdAt: "2026-10-29T12:00:00.124" }),
    ]) expect(changed).not.toBe(base)
  })

  it("is keyed: another key gives another hash, and no key refuses to hash", () => {
    const a = linkHash("t1", 1, GENESIS_HASH, row)
    process.env.AUDIT_CHAIN_KEY = "z".repeat(40)
    expect(linkHash("t1", 1, GENESIS_HASH, row)).not.toBe(a)
    process.env.AUDIT_CHAIN_KEY = "short"
    expect(() => linkHash("t1", 1, GENESIS_HASH, row)).toThrow(AuditChainKeyError)
    delete process.env.AUDIT_CHAIN_KEY
    expect(() => checkpointHmac("t1", 1, GENESIS_HASH)).toThrow(AuditChainKeyError)
  })
})
