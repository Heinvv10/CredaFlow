import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ settings: { enabled: true } as { enabled: boolean }, runs: [] as unknown[], report: null as unknown, batches: [] as unknown[] }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole: vi.fn(async () => ({ id: "u-1", role: "ADMIN" })), hasMinRole: () => true }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn(async () => "t-1") }))
vi.mock("@/lib/prisma", () => ({ prisma: { accountingExportBatch: { findMany: vi.fn(async () => state.batches) } } }))
vi.mock("@/lib/ifrs9/store", () => ({ loadSettings: vi.fn(async () => state.settings) }))
vi.mock("@/lib/ifrs9/run-report", () => ({ listRuns: vi.fn(async () => state.runs), loadRunReport: vi.fn(async () => state.report) }))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/ifrs9/Ifrs9RunActions", () => ({ Ifrs9RunActions: ({ months }: { months: unknown[] }) => `[actions:${JSON.stringify(months)}]` }))

import Ifrs9ReportPage from "./page"

const head = (over: Record<string, unknown>) => ({
  id: "r1", kind: "MONTHLY", runDate: "2026-10-31", periodKey: "2026-10", loanCount: 2, totalEadCents: 1_000_000, totalEclCents: 150_000, createdAt: "2026-10-31T21:50:00.000Z",
  late: false, superseded: false, stale: false, supersedesRunId: null, reason: null, ...over,
})
const stage = (n: number, loans: number, ead: number, ecl: number, suspendedCents = 0) => ({ stage: n, loans, eadCents: ead, eclCents: ecl, coverageBps: ead ? Math.round((ecl * 10_000) / ead) : 0, suspendedCents })
const render = async () => renderToStaticMarkup(await Ifrs9ReportPage({ searchParams: Promise.resolve({}) }))

describe("IFRS 9 report page", () => {
  beforeEach(() => Object.assign(state, { settings: { enabled: true }, runs: [], report: null, batches: [] }))

  it("says so when no run has been made and offers the actions", async () => {
    const html = await render()
    expect(html).toContain("No IFRS 9 run has been made yet")
    expect(html).toContain("[actions:")
  })

  it("warns while IFRS 9 is off", async () => {
    state.settings = { enabled: false }
    expect(await render()).toContain("IFRS 9 is off for this lender")
  })

  it("shows the stage summary, the movement between stages, the run list with its flags, and the export link", async () => {
    const run = head({})
    state.runs = [run, head({ id: "r0", periodKey: "2026-09", runDate: "2026-09-30", late: true, stale: true, reason: "job down" }), head({ id: "r00", kind: "ON_DEMAND", periodKey: null, runDate: "2026-10-15" })]
    state.report = {
      run, previousRun: head({ id: "r0", periodKey: "2026-09", runDate: "2026-09-30" }),
      summary: { byStage: [stage(1, 1, 800_000, 3_000), stage(2, 0, 0, 0), stage(3, 1, 200_000, 120_000, 20_000)], total: stage(0, 2, 1_000_000, 123_000, 20_000) },
      transitions: { cells: [{ from: "2", to: "3", loans: 1, fromEadCents: 210_000, toEadCents: 200_000 }, { from: "NEW", to: "1", loans: 1, fromEadCents: 0, toEadCents: 800_000 }], deteriorated: 1, improved: 0, unchanged: 0 },
    }
    const html = await render()
    expect(html).toContain("Stage 3")
    expect(html).toContain("1 loan")
    expect(html).toContain("60%")
    expect(html).toContain("New loan")
    expect(html).toContain("Stage 2")
    expect(html).toContain("Late")
    expect(html).toContain("Stale")
    expect(html).toContain("Analysis")
    expect(html).toContain("job down")
    expect(html).toContain("/api/reports/export?type=ifrs9-ecl&amp;runId=r1")
  })

  it("offers the ended months not yet closed, with the current run to replace where there is one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-10T10:00:00+02:00"))
    state.runs = [head({ id: "rA", periodKey: "2026-10" })]
    state.batches = [{ periodKey: "2026-09" }]
    const html = await render()
    vi.useRealTimers()
    expect(html).toContain("2026-10")
    expect(html).toContain("&quot;currentRunId&quot;:&quot;rA&quot;")
    expect(html).not.toContain("&quot;periodKey&quot;:&quot;2026-09&quot;")
  })
})
