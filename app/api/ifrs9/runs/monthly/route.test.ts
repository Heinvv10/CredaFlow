import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  totpRequired: false,
  totpVerified: true,
  current: null as { id: string } | null,
  runError: null as Error | null,
  calls: [] as unknown[],
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ user: { id: "u-1", email: "a@x.invalid", totpVerified: state.totpVerified } })),
}))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, run: (t: { id: string }) => unknown) => run({ id: "t-1" }) }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: vi.fn(async () => state.totpRequired) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/ifrs9/run", async () => ({
  ...(await vi.importActual<typeof import("@/lib/ifrs9/run")>("@/lib/ifrs9/run")),
  currentMonthlyRun: vi.fn(async () => state.current),
  executeRun: vi.fn(async (_t: string, options: unknown) => { state.calls.push(options); if (state.runError) throw state.runError; return { runId: "new", created: true } }),
}))

import { Ifrs9RunError } from "@/lib/ifrs9/run"
import { POST } from "./route"

const post = (body: unknown) => POST(new NextRequest("http://x.invalid/api/ifrs9/runs/monthly", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }))

beforeEach(() => Object.assign(state, { totpRequired: false, totpVerified: true, current: null, runError: null, calls: [] }))

describe("POST /api/ifrs9/runs/monthly", () => {
  it("adds a late run for a month that has none, with the reason", async () => {
    expect((await post({ periodKey: "2026-10", reason: "the month-end job was down" })).status).toBe(201)
    expect(state.calls).toEqual([expect.objectContaining({ kind: "MONTHLY", periodKey: "2026-10", lateReason: "the month-end job was down", supersede: undefined })])
  })

  it("supersedes the current run when it is named, with the reason", async () => {
    state.current = { id: "r1" }
    expect((await post({ periodKey: "2026-10", reason: "wrong PD for stage 2", supersedesRunId: "r1" })).status).toBe(201)
    expect(state.calls).toEqual([expect.objectContaining({ supersede: { runId: "r1", reason: "wrong PD for stage 2" } })])
  })

  it("will not replace a month's run unless it is named", async () => {
    state.current = { id: "r1" }
    const res = await post({ periodKey: "2026-10", reason: "again" })
    expect(res.status).toBe(409)
    expect((await res.json()).currentRunId).toBe("r1")
    expect(state.calls).toEqual([])
  })

  it.each([
    [{ periodKey: "2026-10" }],
    [{ periodKey: "2026-10", reason: "   " }],
    [{ reason: "x" }],
    [{ periodKey: "2026-10", reason: "x", supersedesRunId: 5 }],
  ])("refuses %j without calling the run", async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(state.calls).toEqual([])
  })

  it("answers 409 for a closed month, a stale supersede and missing parameters, 400 for a month that has not ended", async () => {
    for (const code of ["PERIOD_CLOSED", "SUPERSEDE_STALE", "PARAMETERS_MISSING"] as const) {
      state.runError = new Ifrs9RunError(code, "no")
      expect((await post({ periodKey: "2026-10", reason: "x" })).status).toBe(409)
    }
    state.runError = new Ifrs9RunError("PERIOD_NOT_ENDED", "no")
    expect((await post({ periodKey: "2026-10", reason: "x" })).status).toBe(400)
  })

  it("needs a verified second factor when the lender requires one", async () => {
    state.totpRequired = true
    state.totpVerified = false
    expect((await post({ periodKey: "2026-10", reason: "x" })).status).toBe(403)
    expect(state.calls).toEqual([])
  })
})
