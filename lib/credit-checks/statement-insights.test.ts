import { beforeEach, describe, expect, it, vi } from "vitest"
import { facts, statement, tx } from "./facts.test-helpers"

const loadMock = vi.fn()
vi.mock("./load-facts", () => ({ loadApplicationFacts: (...a: unknown[]) => loadMock(...a) }))

import { applicationStatementInsights } from "./statement-insights"

beforeEach(() => vi.resetAllMocks())

describe("applicationStatementInsights", () => {
  it("uses the checks' own statement set, persisted reads only, and counts what was not read", async () => {
    const read = statement([tx("2026-07-02", "Card Purchase: SHOPRITE", -84_550)])
    const pending = { ...statement([]), documentId: "doc-2", state: "PENDING" as const, read: null }
    loadMock.mockResolvedValue({ facts: facts({ statements: [read, pending], declaredExpensesCents: 300_000 }) })
    const r = await applicationStatementInsights("t1", "app-1")
    expect(loadMock).toHaveBeenCalledWith("t1", "app-1", { persistedOnly: true })
    expect(r!.read.map((s) => s.documentId)).toEqual(["doc-1"])
    expect(r!.unread).toBe(1)
    expect(r!.insights.declaredCents).toBe(300_000)
    expect(r!.insights.months.map((m) => m.month)).toEqual(["2026-07"])
  })

  it("is null for an application the tenant does not have", async () => {
    loadMock.mockResolvedValue(null)
    expect(await applicationStatementInsights("t1", "other")).toBeNull()
  })
})
