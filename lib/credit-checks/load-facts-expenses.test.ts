/** loadApplicationFacts carries the client's declared monthly expenses (cents, as captured) for EXPENSE_UNDERSTATED. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const appFind = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: (a: unknown) => appFind(a), findMany: async () => [] },
    clientDocument: { findMany: async () => [] },
    creditBureauCheck: { findFirst: async () => null },
  },
}))
vi.mock("@/lib/statement-analysis/persist", () => ({ ensureStatementAnalysis: vi.fn(), readStatementInBackground: vi.fn() }))

import { loadApplicationFacts } from "./load-facts"

const client = { firstName: "Thabo", lastName: "Tester", idNumber: "9001015000080", monthlyIncome: 1_800_000, popiaConsentGiven: true, debtObligations: [] }

beforeEach(() => vi.resetAllMocks())

describe("loadApplicationFacts: declared expenses", () => {
  it("asks for Client.monthlyExpenses and passes it on as cents", async () => {
    appFind.mockResolvedValue({ id: "app-1", status: "UNDER_REVIEW", clientId: "c1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"), client: { ...client, monthlyExpenses: 300_000 } })
    const loaded = await loadApplicationFacts("t1", "app-1")
    expect(loaded!.facts.declaredExpensesCents).toBe(300_000)
    expect((appFind.mock.calls[0][0] as { select: { client: { select: Record<string, unknown> } } }).select.client.select.monthlyExpenses).toBe(true)
  })

  it("reads the column's default 0 as not captured", async () => {
    appFind.mockResolvedValue({ id: "app-1", status: "UNDER_REVIEW", clientId: "c1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"), client: { ...client, monthlyExpenses: 0 } })
    expect((await loadApplicationFacts("t1", "app-1"))!.facts.declaredExpensesCents).toBeNull()
  })
})
