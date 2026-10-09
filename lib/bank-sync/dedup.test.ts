import { describe, it, expect } from "vitest"
import { computeDedupHash } from "./dedup"
import type { ParsedStatementLine } from "./types"

const line: ParsedStatementLine = {
  postedDate: new Date(Date.UTC(2026, 6, 10)), valueDate: null, amountCents: 150000,
  direction: "CREDIT", rawReference: "LN-0099", counterparty: "EFT",
  balanceCents: 2500000, bankTxnId: null,
}

describe("computeDedupHash", () => {
  it("is stable for identical lines within a tenant", () => {
    expect(computeDedupHash(line, "t1")).toBe(computeDedupHash({ ...line }, "t1"))
  })
  it("differs across tenants and across amounts", () => {
    expect(computeDedupHash(line, "t1")).not.toBe(computeDedupHash(line, "t2"))
    expect(computeDedupHash(line, "t1")).not.toBe(computeDedupHash({ ...line, amountCents: 1 }, "t1"))
  })
  it("prefers the bank txn id when present", () => {
    const a = computeDedupHash({ ...line, bankTxnId: "BANK123" }, "t1")
    const b = computeDedupHash({ ...line, bankTxnId: "BANK123", rawReference: "different" }, "t1")
    expect(a).toBe(b)
  })
})
