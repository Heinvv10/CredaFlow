import { beforeEach, describe, expect, it, vi } from "vitest"

const analysisFindMany = vi.fn()
const documentFindMany = vi.fn()
const userFindMany = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    statementAnalysis: { findMany: (a: unknown) => analysisFindMany(a) },
    clientDocument: { findMany: (a: unknown) => documentFindMany(a) },
    user: { findMany: (a: unknown) => userFindMany(a) },
  },
}))

import type { ApplicationCheckFlag } from "@prisma/client"
import { flagViews } from "./evidence"

const flag = (over: Partial<ApplicationCheckFlag>): ApplicationCheckFlag => ({
  id: "f1", tenantId: "t1", applicationId: "app-1", check: "RISK_BEHAVIOUR", code: "GAMBLING", fingerprint: "fp",
  status: "OPEN", summary: "Betting.", evidence: {}, raisedAt: new Date("2026-10-13T08:00:00Z"), updatedAt: new Date(),
  clearedById: null, clearedAt: null, clearReason: null, ...over,
})
const rows = Array.from({ length: 30 }, (_, i) => ({ date: "2026-07-01", description: `ROW ${i}`, amountCents: -i, balanceCents: i, page: 1 + Math.floor(i / 10) }))

beforeEach(() => {
  vi.resetAllMocks()
  analysisFindMany.mockResolvedValue([{ id: "an-1", transactions: rows }])
  documentFindMany.mockResolvedValue([{ id: "doc-1", fileName: "statement.pdf" }])
  userFindMany.mockResolvedValue([{ id: "u1", name: "Officer One", email: "o@test.invalid" }])
})

describe("flagViews", () => {
  it("quotes the rows the evidence names, at most 20, from the read the flag was raised on", async () => {
    const indexes = Array.from({ length: 25 }, (_, i) => i)
    const { flags } = await flagViews("t1", [flag({ evidence: { documentId: "doc-1", analysisId: "an-1", transactionIndexes: [...indexes, 99] } })])
    expect(flags[0].rows).toHaveLength(20)
    expect(flags[0].rows[3]).toEqual({ index: 3, date: "2026-07-01", description: "ROW 3", amountCents: -3, balanceCents: 3, page: 1 })
    expect(flags[0]).toMatchObject({ documentId: "doc-1", documentName: "statement.pdf", pages: [1, 2] })
  })

  it("names every document a flag cites as accessed, rows or not, once each", async () => {
    const { documentIds } = await flagViews("t1", [
      flag({ id: "a", evidence: { documentId: "doc-1", analysisId: "an-1", transactionIndexes: [0] } }),
      flag({ id: "b", evidence: { documentId: "doc-1" } }),
      flag({ id: "c", evidence: { documentId: "doc-2" } }),
      flag({ id: "d", evidence: {} }),
      flag({ id: "e", code: "NO_SALARY_CREDIT", evidence: { payslipDocumentId: "slip-1", documentIds: ["doc-1", "doc-3"] } }),
    ])
    expect(documentIds.sort()).toEqual(["doc-1", "doc-2", "doc-3", "slip-1"])
  })

  it("shows superseded and cleared flags with who cleared them", async () => {
    const { flags } = await flagViews("t1", [
      flag({ id: "s", status: "SUPERSEDED" }),
      flag({ id: "c", status: "CLEARED", clearedById: "u1", clearedAt: new Date("2026-10-13T09:00:00Z"), clearReason: "Within budget, confirmed." }),
    ])
    expect(flags.map((f) => f.status)).toEqual(["SUPERSEDED", "CLEARED"])
    expect(flags[1]).toMatchObject({ clearedByName: "Officer One", clearReason: "Within budget, confirmed." })
  })

  it("strips bidi overrides and control characters from statement text", async () => {
    analysisFindMany.mockResolvedValue([{ id: "an-1", transactions: [{ ...rows[0], description: "PAY‮TO\u0007 X" }] }])
    const { flags } = await flagViews("t1", [flag({ summary: "Debit to ‮X", evidence: { documentId: "doc-1", analysisId: "an-1", transactionIndexes: [0] } })])
    expect(flags[0].rows[0].description).toBe("PAYTO X")
    expect(flags[0].summary).toBe("Debit to X")
  })

  it("scopes every lookup to the tenant", async () => {
    await flagViews("t1", [flag({ clearedById: "u1", status: "CLEARED", evidence: { documentId: "doc-1", analysisId: "an-1" } })])
    for (const m of [analysisFindMany, documentFindMany, userFindMany]) {
      expect(m).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1" }) }))
    }
  })
})
