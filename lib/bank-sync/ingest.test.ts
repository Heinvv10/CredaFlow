import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: {
      findUnique: vi.fn(),
      create: vi.fn(async ({ data }) => ({ id: "txn_" + data.dedupHash.slice(0, 6), ...data })),
    },
  },
}))

import { prisma } from "@/lib/prisma"
import { persistTransactions } from "./ingest"
import type { MatchResult } from "./types"

function result(ref: string, amount = 150000): MatchResult {
  return {
    line: { postedDate: new Date(Date.UTC(2026, 6, 10)), valueDate: null, amountCents: amount,
      direction: "CREDIT", rawReference: ref, counterparty: "EFT", balanceCents: null, bankTxnId: null },
    tier: "EXACT", confidence: "HIGH", matchedLoanId: "loanA",
  }
}

describe("persistTransactions", () => {
  beforeEach(() => vi.clearAllMocks())

  it("creates a row per new line and maps tier→matchStatus", async () => {
    vi.mocked(prisma.bankTransaction.findUnique).mockResolvedValue(null)
    const { newTxnCount, created } = await persistTransactions({
      tenantId: "t1", importId: "imp1", results: [result("LN-0099")],
    })
    expect(newTxnCount).toBe(1)
    const arg = vi.mocked(prisma.bankTransaction.create).mock.calls[0][0].data
    expect(arg).toMatchObject({
      tenantId: "t1", importId: "imp1", amountCents: 150000,
      matchStatus: "PROPOSED", matchConfidence: "HIGH", matchedLoanId: "loanA",
    })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ matchedLoanId: "loanA", confidence: "HIGH" })
  })

  it("skips a line whose dedupHash already exists (idempotent)", async () => {
    vi.mocked(prisma.bankTransaction.findUnique).mockResolvedValue({ id: "existing" } as never)
    const { newTxnCount, created } = await persistTransactions({
      tenantId: "t1", importId: "imp1", results: [result("LN-0099")],
    })
    expect(newTxnCount).toBe(0)
    expect(created).toHaveLength(0)
    expect(prisma.bankTransaction.create).not.toHaveBeenCalled()
  })

  it("maps an unmatched line to UNMATCHED", async () => {
    vi.mocked(prisma.bankTransaction.findUnique).mockResolvedValue(null)
    const none = { ...result("x"), tier: "NONE" as const, confidence: null, matchedLoanId: null }
    await persistTransactions({ tenantId: "t1", importId: "imp1", results: [none] })
    expect(vi.mocked(prisma.bankTransaction.create).mock.calls[0][0].data.matchStatus).toBe("UNMATCHED")
  })
})
