/**
 * The cron's verdict: a step that records an error makes the run not ok, so
 * the route answers non-2xx (H5) and a partial failure is never silent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  ingest: vi.fn(),
  cancelAtProvider: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findMany: m.findMany } } }))
vi.mock("./context", async (orig) => ({
  ...(await orig<typeof import("./context")>()),
  loadEngineContext: async (tenantId: string, now: Date) => ({ tenantId, now, provider: { id: "simulated" }, creds: {} }),
}))
vi.mock("./results", () => ({ ingestResults: m.ingest }))
vi.mock("./mandate-sweeps", () => ({
  emptySweep: () => ({ closed: 0, providerCancelled: 0, errors: [] }),
  cancelAtProvider: m.cancelAtProvider,
  closeMandatesOfClosedLoans: vi.fn(),
}))

import { runCollectionsCron, tenantRunErrors } from "./cron"

const clean = { fetched: 0, recorded: 0, duplicates: 0, unmatched: 0, allocated: 0, needsReview: 0, suspended: 0, errors: [] as string[] }

describe("runCollectionsCron verdict", () => {
  beforeEach(() => {
    m.findMany.mockReset().mockResolvedValue([{ tenantId: "t1" }])
    m.ingest.mockReset().mockResolvedValue(clean)
    m.cancelAtProvider.mockReset().mockResolvedValue(undefined)
  })

  it("is ok when no step recorded an error", async () => {
    expect((await runCollectionsCron("RESULTS", new Date())).ok).toBe(true)
  })

  it("is not ok when a step recorded an error, even though the tenant run itself completed", async () => {
    m.ingest.mockResolvedValue({ ...clean, errors: ["CI123: stop rules: Error"] })
    const run = await runCollectionsCron("RESULTS", new Date())
    expect(run.perTenant[0].outcome).toBe("RESULTS")
    expect(run.ok).toBe(false)
    expect(tenantRunErrors(run.perTenant[0])).toEqual(["CI123: stop rules: Error"])
  })

  it("is not ok when the provider cancel sweep failed", async () => {
    m.cancelAtProvider.mockImplementation(async (_ctx: unknown, s: { errors: string[] }) => { s.errors.push("m1: provider cancel failed") })
    expect((await runCollectionsCron("RESULTS", new Date())).ok).toBe(false)
  })

  it("is not ok when a tenant failed outright", async () => {
    m.ingest.mockRejectedValue(new Error("db down"))
    const run = await runCollectionsCron("RESULTS", new Date())
    expect(run).toMatchObject({ ok: false, perTenant: [{ outcome: "ERROR", error: "Error" }] })
  })
})
