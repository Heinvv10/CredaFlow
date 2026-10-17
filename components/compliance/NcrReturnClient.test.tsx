import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { NcrReturnData } from "@/lib/compliance/ncr-return"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }))

import { NcrReturnClient } from "./NcrReturnClient"

const base: NcrReturnData = {
  quarter: "2026-Q3", periodStart: new Date("2026-06-30T22:00:00Z"), periodEnd: new Date("2026-09-30T21:59:59.999Z"),
  quarterOpen: false, ncrNumber: "NCRCP12345", collectibleBook: { count: 1, value: 100_00 },
  lines: [{ key: "book", label: "Collectible book", count: 1, value: 100_00, basis: "POSITION" }],
  submittedAt: null, submittedByName: null, filed: null, positionIsStale: true, filedSnapshotUnreadable: false,
  positionSource: "LIVE", positionAsOf: null, historyStartsOn: null,
}

const render = (over: Partial<NcrReturnData>) =>
  renderToStaticMarkup(<NcrReturnClient data={{ ...base, ...over }} selectableQuarters={["2026-Q3", "2026-Q4"]} canSubmit={false} />)
    .replace(/<!-- -->/g, "")

// Workstream G: the page says where arrears history starts and when a closed
// quarter's position comes from it.
describe("NCR return page: arrears history", () => {
  it("says history has not started and is not backfilled, beside the stale warning", () => {
    const html = render({})
    expect(html).toContain("has closed and no return was filed")
    expect(html).toContain("Daily arrears history has not started yet")
    expect(html).toContain("not backfilled")
  })

  it("reads a closed quarter from its last day's history, with no stale warning", () => {
    const html = render({ positionIsStale: false, positionSource: "SNAPSHOT", positionAsOf: new Date("2026-09-30T00:00:00Z"), historyStartsOn: new Date("2026-08-01T00:00:00Z") })
    expect(html).toContain("from the daily arrears history")
    expect(html).not.toContain("has closed and no return was filed")
  })
})
