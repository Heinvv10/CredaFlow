import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  runs: [] as Array<{ tenantId: string; periodKey: string | undefined }>,
}))

vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/ifrs9/store", () => ({ loadSettings: vi.fn(async () => state.settings) }))
vi.mock("@/lib/ifrs9/run", () => ({
  executeRun: vi.fn(async (tenantId: string, o: { periodKey?: string }) => { state.runs.push({ tenantId, periodKey: o.periodKey }); return { runId: "r", created: true } }),
}))
vi.mock("@/lib/ops/tenant-sweep", async () => ({
  ...(await vi.importActual<typeof import("@/lib/ops/tenant-sweep")>("@/lib/ops/tenant-sweep")),
  sweepActiveTenants: vi.fn(async (_job: string, run: (t: { id: string; name: string }) => Promise<unknown>) => [
    { tenant: { id: "t-1", name: "T" }, ok: true, value: await run({ id: "t-1", name: "T" }) },
  ]),
}))

import { GET } from "./route"

const at = (iso: string) => vi.setSystemTime(new Date(`${iso}+02:00`))
const call = () => GET(new NextRequest("http://x.invalid/api/cron/ifrs9-run"))

describe("ifrs9-run cron", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state.runs = []
    state.settings = { ...DEFAULT_SETTINGS, enabled: true }
  })
  afterEach(() => vi.useRealTimers())

  it("does nothing in the middle of the month", async () => {
    at("2026-10-15T23:50:00")
    const body = await (await call()).json()
    expect(body).toMatchObject({ ok: true, ran: false })
    expect(state.runs).toEqual([])
  })

  it("makes the month's run on its last SAST day", async () => {
    at("2026-10-31T23:50:00")
    expect((await call()).status).toBe(200)
    expect(state.runs).toEqual([{ tenantId: "t-1", periodKey: "2026-10" }])
  })

  it("makes up last month's run in the first five days of the next", async () => {
    at("2026-11-03T23:50:00")
    await call()
    expect(state.runs).toEqual([{ tenantId: "t-1", periodKey: "2026-10" }])
  })

  it("skips a lender that has IFRS 9 off, and a month before the one it takes effect", async () => {
    at("2026-10-31T23:50:00")
    state.settings = { ...DEFAULT_SETTINGS, enabled: false }
    await call()
    state.settings = { ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-11" }
    await call()
    expect(state.runs).toEqual([])
  })
})
