import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: { findMany: vi.fn() },
    loan: { findMany: vi.fn() },
  },
}))

import { prisma } from "@/lib/prisma"
import { getReconciliationData } from "./data"

const findManyTxn = vi.mocked(prisma.bankTransaction.findMany)
const findManyLoan = vi.mocked(prisma.loan.findMany)

describe("getReconciliationData", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findManyTxn.mockResolvedValue([] as never)
    findManyLoan.mockResolvedValue([] as never)
  })

  it("only queries CREDIT transactions — debits (bank fees) never reach the review queue", async () => {
    await getReconciliationData("t1")

    const where = findManyTxn.mock.calls[0][0]?.where
    // Debits land as UNMATCHED but must be excluded from the review UI (kept stored).
    expect(where).toMatchObject({
      tenantId: "t1",
      direction: "CREDIT",
      matchStatus: { in: ["PROPOSED", "UNMATCHED"] },
    })
  })

  it("scopes the candidate-loan query to the tenant and only ACTIVE/DEFAULTED loans", async () => {
    // No matched loan ids (txns empty) → the only loan.findMany call is the candidate query.
    await getReconciliationData("t1")

    const loanWhere = findManyLoan.mock.calls[0]?.[0]?.where
    expect(loanWhere).toMatchObject({ tenantId: "t1", status: { in: ["ACTIVE", "DEFAULTED"] } })
  })

  it("maps a matched CREDIT row to the shape the client expects, resolving the loan label", async () => {
    findManyTxn.mockResolvedValue([
      {
        id: "txn1",
        postedDate: new Date(Date.UTC(2026, 6, 10)),
        amountCents: 150000,
        rawReference: "LN-0099",
        counterparty: "EFT",
        matchStatus: "PROPOSED",
        matchConfidence: "HIGH",
        matchedLoanId: "loanA",
      },
    ] as never)
    // First loan query = matched loans, second = candidate loans.
    findManyLoan
      .mockResolvedValueOnce([
        { id: "loanA", reference: "LN-0099", client: { firstName: "Thabo", lastName: "M" } },
      ] as never)
      .mockResolvedValueOnce([] as never)

    const { txns } = await getReconciliationData("t1")

    expect(txns).toHaveLength(1)
    expect(txns[0]).toMatchObject({
      id: "txn1",
      amountCents: 150000,
      matchStatus: "PROPOSED",
      matchedLoan: { reference: "LN-0099" },
    })
    expect(txns[0].postedDate).toBe(new Date(Date.UTC(2026, 6, 10)).toISOString())
  })
})
