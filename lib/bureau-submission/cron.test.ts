import { beforeEach, describe, expect, it, vi } from "vitest"

const { findMany, generateMonthly, pushConfigured } = vi.hoisted(() => ({
  findMany: vi.fn(),
  generateMonthly: vi.fn(),
  pushConfigured: vi.fn(() => false),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findMany } } }))
vi.mock("./generate", () => ({
  generateMonthly,
  generateDaily: vi.fn(),
  submissionMode: () => (process.env.BUREAU_SUBMISSION_MODE === "LIVE" ? "LIVE" : "TEST"),
}))
vi.mock("./push", () => ({ pushConfigured }))

import { runBureauCron } from "./cron"
import { BureauError } from "./validate"

// What a run DOES is proven against real Postgres in daily.integration.test.ts.
// This covers the two things that suite cannot reach without breaking the
// database: an unexpected error's message, and LIVE with a transport present.

const NOW = new Date("2026-08-31T22:20:00.000Z")

describe("runBureauCron", () => {
  beforeEach(() => {
    delete process.env.BUREAU_SUBMISSION_MODE
    findMany.mockReset().mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }])
    generateMonthly.mockReset().mockResolvedValue({ outcome: "NOT_CONFIGURED" })
    pushConfigured.mockReset().mockReturnValue(false)
  })

  it("never echoes an unexpected error's message, which can quote row values", async () => {
    const leaky = Object.assign(new Error("Invalid `createMany()` invocation: surname MOKOENA idNumber 8001015009087"), { code: "P2009" })
    leaky.name = "PrismaClientValidationError"
    generateMonthly.mockRejectedValueOnce(leaky)
    const run = await runBureauCron("MONTHLY", "2026-08-31", NOW)
    expect(run.ok).toBe(false)
    expect(run.perTenant[0]).toEqual({ tenantId: "t1", outcome: "ERROR", error: "PrismaClientValidationError P2009" })
    expect(JSON.stringify(run)).not.toMatch(/MOKOENA|8001015009087/)
    // One tenant failing does not stop the next.
    expect(run.perTenant[1]).toEqual({ tenantId: "t2", outcome: "NOT_CONFIGURED" })
  })

  it("does echo this module's own refusals, which name a rule or a period", async () => {
    generateMonthly.mockRejectedValueOnce(new BureauError("Bureau period 2026-08-31 has not ended"))
    const run = await runBureauCron("MONTHLY", "2026-08-31", NOW)
    expect(run.perTenant[0]).toMatchObject({ outcome: "ERROR", error: "Bureau period 2026-08-31 has not ended" })
  })

  it("refuses LIVE before reading any tenant while no transport exists, and runs it once one does", async () => {
    process.env.BUREAU_SUBMISSION_MODE = "LIVE"
    const refused = await runBureauCron("MONTHLY", "2026-08-31", NOW)
    expect(refused).toMatchObject({ ok: false, mode: "LIVE", perTenant: [] })
    expect(findMany).not.toHaveBeenCalled()
    expect(generateMonthly).not.toHaveBeenCalled()

    pushConfigured.mockReturnValue(true)
    const ran = await runBureauCron("MONTHLY", "2026-08-31", NOW)
    expect(ran.ok).toBe(true)
    expect(generateMonthly).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "t1", mode: "LIVE", periodDay: "2026-08-31" }))
    delete process.env.BUREAU_SUBMISSION_MODE
  })
})
