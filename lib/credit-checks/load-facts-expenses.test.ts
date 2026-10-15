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

import { declaredExpenses, loadApplicationFacts } from "./load-facts"

const client = { firstName: "Thabo", lastName: "Tester", idNumber: "9001015000080", monthlyIncome: 1_800_000, popiaConsentGiven: true, debtObligations: [] }

beforeEach(() => vi.resetAllMocks())

describe("loadApplicationFacts: declared expenses", () => {
  it("asks for Client.monthlyExpenses and passes it on as cents", async () => {
    appFind.mockResolvedValue({ id: "app-1", status: "UNDER_REVIEW", clientId: "c1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"), client: { ...client, monthlyExpenses: 300_000, monthlyExpensesDeclaredAt: null } })
    const loaded = await loadApplicationFacts("t1", "app-1")
    expect(loaded!.facts.declaredExpensesCents).toBe(300_000)
    expect((appFind.mock.calls[0][0] as { select: { client: { select: Record<string, unknown> } } }).select.client.select.monthlyExpenses).toBe(true)
  })

  it("reads the column's default 0 as not captured", async () => {
    appFind.mockResolvedValue({ id: "app-1", status: "UNDER_REVIEW", clientId: "c1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"), client: { ...client, monthlyExpenses: 0, monthlyExpensesDeclaredAt: null } })
    expect((await loadApplicationFacts("t1", "app-1"))!.facts.declaredExpensesCents).toBeNull()
  })

  it("reads an explicit R0 declaration as a declared 0", async () => {
    appFind.mockResolvedValue({ id: "app-1", status: "UNDER_REVIEW", clientId: "c1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"), client: { ...client, monthlyExpenses: 0, monthlyExpensesDeclaredAt: new Date("2026-10-04T08:00:00Z") } })
    expect((await loadApplicationFacts("t1", "app-1"))!.facts.declaredExpensesCents).toBe(0)
    expect((appFind.mock.calls[0][0] as { select: { client: { select: Record<string, unknown> } } }).select.client.select.monthlyExpensesDeclaredAt).toBe(true)
  })
})

describe("declaredExpenses", () => {
  it("is the captured figure when declared, else only a figure above the column's default", () => {
    const at = new Date("2026-10-04T08:00:00Z")
    expect(declaredExpenses({ monthlyExpenses: 0, monthlyExpensesDeclaredAt: at })).toBe(0)
    expect(declaredExpenses({ monthlyExpenses: 0, monthlyExpensesDeclaredAt: null })).toBeNull()
    // Captured before the column existed: a figure above 0 was always a declaration.
    expect(declaredExpenses({ monthlyExpenses: 300_000, monthlyExpensesDeclaredAt: null })).toBe(300_000)
    expect(declaredExpenses({ monthlyExpenses: 300_000, monthlyExpensesDeclaredAt: at })).toBe(300_000)
  })
})
