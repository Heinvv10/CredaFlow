import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"

const state = vi.hoisted(() => ({
  totpRequired: false,
  totpVerified: true,
  saved: [] as unknown[],
  replaced: [] as unknown[],
  runResult: null as unknown,
  runError: null as Error | null,
  flagSet: true,
  flagCleared: true,
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ user: { id: "u-1", email: "a@x.invalid", totpVerified: state.totpVerified } })),
}))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, run: (t: { id: string }) => unknown) => run({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: vi.fn(async () => state.totpRequired) }))
vi.mock("@/lib/prisma", () => ({ prisma: { ifrs9SicrFlag: { findMany: vi.fn(async () => []) } } }))
vi.mock("@/lib/ifrs9/store", () => ({
  loadSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  saveSettings: vi.fn(async (_db: unknown, _t: string, next: unknown) => { state.saved.push(next) }),
  loadParameters: vi.fn(async () => []),
  replaceParameters: vi.fn(async (_db: unknown, _t: string, rows: unknown) => { state.replaced.push(rows) }),
  setSicrFlag: vi.fn(async () => state.flagSet),
  clearSicrFlag: vi.fn(async () => state.flagCleared),
}))
vi.mock("@/lib/ifrs9/run", async () => ({
  ...(await vi.importActual<typeof import("@/lib/ifrs9/run")>("@/lib/ifrs9/run")),
  executeRun: vi.fn(async () => { if (state.runError) throw state.runError; return state.runResult }),
}))
vi.mock("@/lib/ifrs9/run-report", () => ({ listRuns: vi.fn(async () => []), loadRunReport: vi.fn(async () => null) }))

import { Ifrs9RunError } from "@/lib/ifrs9/run"
import * as flags from "./flags/route"
import * as parameters from "./parameters/route"
import * as runs from "./runs/route"
import * as settings from "./settings/route"

const request = (method: string, body?: unknown, query = "") =>
  new NextRequest(`http://x.invalid/api/ifrs9/x${query}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })

const FULL_TABLE = [1, 2, 3].map((stage) => ({ scopeKey: "DEFAULT", stage, pdBps: 100 * stage, lgdBps: 4500 }))

beforeEach(() => {
  Object.assign(state, { totpRequired: false, totpVerified: true, saved: [], replaced: [], runResult: null, runError: null, flagSet: true, flagCleared: true })
})

describe("settings", () => {
  it("saves a valid partial body merged over the stored settings", async () => {
    const res = await settings.PUT(request("PUT", { sicrDpdOver: 20 }))
    expect(res.status).toBe(200)
    expect(state.saved).toEqual([{ ...DEFAULT_SETTINGS, sicrDpdOver: 20 }])
  })

  it("makes a newly enabled lender effective from the current month", async () => {
    const res = await settings.PUT(request("PUT", { enabled: true }))
    expect(res.status).toBe(200)
    const saved = state.saved[0] as { enabled: boolean; effectiveFromMonth: string }
    expect(saved.enabled).toBe(true)
    expect(saved.effectiveFromMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
  })

  it("refuses an invalid body and writes nothing", async () => {
    expect((await settings.PUT(request("PUT", { sicrDpdOver: 95 }))).status).toBe(400)
    expect(state.saved).toEqual([])
  })

  it("refuses a write without a verified second factor when the lender requires one", async () => {
    state.totpRequired = true
    state.totpVerified = false
    expect((await settings.PUT(request("PUT", { enabled: true }))).status).toBe(403)
    expect(state.saved).toEqual([])
  })
})

describe("parameters", () => {
  it("replaces the table with a valid one", async () => {
    expect((await parameters.PUT(request("PUT", { parameters: FULL_TABLE }))).status).toBe(200)
    expect(state.replaced).toEqual([FULL_TABLE])
  })

  it("refuses a table without the lender default for every stage", async () => {
    const res = await parameters.PUT(request("PUT", { parameters: FULL_TABLE.slice(0, 2) }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("stage 3")
    expect(state.replaced).toEqual([])
  })

  it("refuses a PD above 100%", async () => {
    const res = await parameters.PUT(request("PUT", { parameters: [{ ...FULL_TABLE[0], pdBps: 10_001 }, ...FULL_TABLE.slice(1)] }))
    expect(res.status).toBe(400)
    expect(state.replaced).toEqual([])
  })
})

describe("runs", () => {
  it("answers 201 for a new run and 200 for the month's existing one", async () => {
    state.runResult = { runId: "r1", created: true }
    expect((await runs.POST(request("POST", { kind: "MONTHLY" }))).status).toBe(201)
    state.runResult = { runId: "r1", created: false }
    expect((await runs.POST(request("POST", { kind: "MONTHLY" }))).status).toBe(200)
  })

  it("refuses an unknown kind", async () => {
    expect((await runs.POST(request("POST", { kind: "WEEKLY" }))).status).toBe(400)
  })

  it("maps the run's refusals: missing parameters is a conflict, a bad period a bad request", async () => {
    state.runError = new Ifrs9RunError("PARAMETERS_MISSING", "Set the PD")
    expect((await runs.POST(request("POST", { kind: "ON_DEMAND" }))).status).toBe(409)
    state.runError = new Ifrs9RunError("INVALID_PERIOD", "no")
    expect((await runs.POST(request("POST", { kind: "MONTHLY", periodKey: "2020-01" }))).status).toBe(400)
  })

  it("lets an unexpected failure surface rather than answering 4xx", async () => {
    state.runError = new Error("db down")
    await expect(runs.POST(request("POST", { kind: "ON_DEMAND" }))).rejects.toThrow("db down")
  })
})

describe("flags", () => {
  it("sets a flag of a known kind with a reason", async () => {
    expect((await flags.POST(request("POST", { loanId: "l1", kind: "WATCHLIST", reason: "on the watchlist" }))).status).toBe(201)
  })

  it.each([
    [{ loanId: "l1", kind: "MOOD", reason: "x" }],
    [{ loanId: "l1", kind: "WATCHLIST", reason: "  " }],
    [{ kind: "WATCHLIST", reason: "x" }],
  ])("refuses %j", async (body) => {
    expect((await flags.POST(request("POST", body))).status).toBe(400)
  })

  it("is a 404 for another lender's loan and for a flag that is not active", async () => {
    state.flagSet = false
    expect((await flags.POST(request("POST", { loanId: "l1", kind: "WATCHLIST", reason: "x" }))).status).toBe(404)
    state.flagCleared = false
    expect((await flags.DELETE(request("DELETE", undefined, "?id=f1"))).status).toBe(404)
  })
})
