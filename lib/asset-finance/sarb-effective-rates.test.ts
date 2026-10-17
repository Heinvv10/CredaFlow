import { describe, expect, it, vi } from "vitest"
import { fetchSarbEffectiveObservations, parseSarbHistory } from "./sarb-effective-rates"

describe("SARB effective dates", () => {
  it("uses the dated change series, never the day a homepage value was observed", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify([
      { Period: "2026-09-25T00:00:00", Value: String(url).includes("MRDPRIME") ? 10.75 : 7.25 },
    ]))) as unknown as typeof fetch
    const result = await fetchSarbEffectiveObservations(fetcher)
    expect(vi.mocked(fetcher).mock.calls.every(([url]) => String(url).includes("/1900-01-01/"))).toBe(true)
    expect(result).toMatchObject({ ok: true, observations: [
      { basis: "PRIME", effectiveDate: "2026-09-25" },
      { basis: "REPO", effectiveDate: "2026-09-25" },
      { basis: "ZARONIA", effectiveDate: "2026-09-25" },
    ] })
  })
  it("preserves small daily ZARONIA changes and a return to an earlier value, oldest first", () => {
    const result = parseSarbHistory([
      { Period: "2026-10-15T00:00:00", Value: 7.097 },
      { Period: "2026-10-14T00:00:00", Value: 7.094 },
      { Period: "2026-10-13T00:00:00", Value: 7.097 },
    ], "ZARONIA", "MMRD855A", "2026-10-17")
    expect(result.ok && result.observations.map((x) => [x.effectiveDate, x.rate.toString()])).toEqual([
      ["2026-10-13", "0.07097"], ["2026-10-14", "0.07094"], ["2026-10-15", "0.07097"],
    ])
  })
  it.each([[null], [[]], [[{ Period: "2026-02-30T00:00:00", Value: 7 }]], [[{ Period: "2027-01-01T00:00:00", Value: 7 }]], [[{ Period: "2026-10-01T00:00:00", Value: 0 }]]])("refuses unusable history", (body) => {
    expect(parseSarbHistory(body, "PRIME", "MRDPRIME", "2026-10-17").ok).toBe(false)
  })
})
