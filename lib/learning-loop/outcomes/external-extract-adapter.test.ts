import { describe, expect, it } from "vitest"
import { history } from "./__fixtures__/loan-facts"
import { addMonths } from "./definition"
import { externalExtractAdapter, extractLoanFacts, type ExtractLoanRow } from "./external-extract-adapter"

// A synthetic extract: opaque keys as an HMAC at source would produce; no person, no lender.
const KEY = "ext-7f3a9c"
const row: ExtractLoanRow = {
  loanKey: KEY,
  decisionRecordId: "dec-ext-1",
  maturityDay: "2026-03-31",
  closure: { status: "SETTLED", day: "2026-04-10" },
  instalments: [
    { key: "a", no: 2, dueDay: "2026-03-31", totalDueCents: 60_000, paidInFull: true, paidDay: "2026-04-10" },
    { key: "b", no: 1, dueDay: "2026-02-28", totalDueCents: 60_000, paidInFull: true, paidDay: "2026-02-27" },
  ],
  dpdHistory: history("2026-02-28", "2026-04-10", (d) => (d > "2026-03-31" ? 5 : 0))
    .map((h) => ({ day: h.day, dpd: h.daysInArrears, defaulted: h.defaulted })),
  returns: [{ key: "r1", no: 2, amountCents: 60_000, reasonCode: "PAYMENT_STOPPED", resolvedAt: new Date("2026-04-02T08:00:00+02:00") }],
}
const ctx = { tenantId: "analysis-tenant", asOf: new Date("2027-06-01T00:30:00+02:00"), today: "2027-06-01", demoTenant: false }

describe("external extract adapter (synthetic fixture, no connection)", () => {
  it("maps an extract into the same definitions, with every ref behind the pseudonymous loan key", async () => {
    const adapter = externalExtractAdapter({ loans: async (tenantId) => (tenantId === ctx.tenantId ? [row] : []) })
    expect(adapter.sourceSystem).toBe("external_extract")
    const result = await adapter.derive(ctx)
    expect(result.failures).toEqual([])
    expect(result.decisionRecordIds).toEqual(["dec-ext-1"])
    expect(result.outcomes.every((o) => o.decisionRecordId === "dec-ext-1" && o.sourceRef.startsWith(KEY))).toBe(true)

    const find = (kind: string, window: string) => result.outcomes.find((o) => o.outcomeKind === kind && o.window === window)
    expect(find("PAID", "INSTALMENT:1")).toMatchObject({ state: "OBSERVED", value: true })
    expect(find("PAID", "INSTALMENT:2")).toMatchObject({ state: "OBSERVED", value: false })
    expect(find("LATE", "INSTALMENT:2")).toMatchObject({ state: "OBSERVED", value: true })
    expect(find("RETURNED_DEBIT_ORDER", "INSTALMENT:2")).toMatchObject({ value: true, reasonCode: "PAYMENT_STOPPED", sourceRef: `${KEY}:r:r1` })
    expect(find("EVER_30_DPD", "TERM_30D")).toMatchObject({ state: "OBSERVED", value: false })
    expect(result.outcomes.some((o) => o.state === "UNOBSERVABLE")).toBe(false)
    expect(find("SETTLED", "3M")).toMatchObject({ state: "OBSERVED", value: true })
    expect(addMonths("2026-02-28", 3)).toBe("2026-05-28")
    expect(extractLoanFacts(row).arrearsHistory.find((h) => h.day === "2026-04-01")).toEqual({ day: "2026-04-01", daysInArrears: 5, defaulted: false })
  })

  it("never reads another tenant's extract", async () => {
    const adapter = externalExtractAdapter({ loans: async (tenantId) => (tenantId === ctx.tenantId ? [row] : []) })
    expect((await adapter.derive({ ...ctx, tenantId: "other" })).outcomes).toEqual([])
  })

  it("counts a malformed loan as a failure and still derives the rest", async () => {
    const broken = { ...row, loanKey: "ext-broken", dpdHistory: null } as unknown as ExtractLoanRow
    const result = await externalExtractAdapter({ loans: async () => [broken, row] }).derive(ctx)
    expect(result.failures.map((f) => f.ref)).toEqual(["ext-broken"])
    expect(result.decisionRecordIds).toEqual(["dec-ext-1"])
  })
})
