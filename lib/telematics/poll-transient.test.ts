import { describe, expect, it, vi } from "vitest"

// Round-2 breaker repro (PR #222), asserting the fix: a transient deadlock
// whose Postgres detail names a backend PID that happens to read like a rule
// SQLSTATE is a failure worth retrying (the classification reads structured
// codes, never the message): counted as failed, the cursor kept, no strike.
const m = vi.hoisted(() => ({
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  logAudit: vi.fn(async (_entry: unknown) => undefined),
  ingestEvent: vi.fn(async () => {
    const { Prisma } = await import("@prisma/client")
    throw new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`. Message: `ERROR: deadlock detected. " +
      "Process 23514 waits for ShareLock on transaction 991; blocked by process 118.`", { code: "P2010", clientVersion: "5", meta: { code: "40P01", message: "deadlock detected" } })
  }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: vi.fn(async () => ({ telematicsPositionRetentionDays: 90 })) },
    trackerDevice: {
      findMany: vi.fn(async () => [{ id: "d1", tenantId: "t1", assetId: "a1", provider: "acme-transient", externalDeviceId: "X-1",
        installedOn: new Date("2026-09-01T00:00:00.000Z"), pollCursor: null, meterVerifiedAt: null, failingEventId: null, failingEventCount: 0 }]),
      updateMany: m.updateMany,
    },
    $queryRaw: vi.fn(async () => [{ id: "d1" }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAudit: m.logAudit }))
vi.mock("./ingest", () => ({ ingestEvent: m.ingestEvent }))

import { pollTenant } from "./poll"
import { registerTelematicsProvider } from "./registry"

const NOW = new Date("2026-09-03T18:00:00.000Z")
registerTelematicsProvider({
  id: "acme-transient", label: "Transient double", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
  poll: async () => ({
    events: [{ providerEventId: "e-1", externalDeviceId: "X-1", occurredAt: new Date("2026-09-03T17:00:00.000Z"), kind: "ALERT", alert: "TAMPER" }],
    cursors: { "X-1": "c-after-e-1" }, simulated: false,
  }),
})

describe("a deadlock (40P01) is retried, never skipped", () => {
  it("keeps the cursor for a TAMPER alert whose deadlock detail's PID reads 23514", async () => {
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ rejected: 0, failed: 1 })
    expect(m.logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "TELEMATICS_EVENT_REJECTED" }))
    const update = m.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }
    expect(update.data).not.toHaveProperty("pollCursor")
    // A deadlock is a passing fault: retried for as long as it lasts, never a strike toward the skip.
    expect(update.data).not.toHaveProperty("failingEventCount")
  })
})
