import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  findDevices: vi.fn(async (_args: unknown) => m.devices),
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  ingestEvent: vi.fn(async (_tx: unknown, _device: unknown, _event: { providerEventId: string }, _ctx: { simulated: boolean }) => ({ stored: true })),
  logAudit: vi.fn(async (_entry: unknown) => undefined),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: vi.fn(async () => ({ telematicsPositionRetentionDays: 90 })), findMany: vi.fn(async () => [{ tenantId: "t1" }]) },
    trackerDevice: { findMany: m.findDevices, updateMany: m.updateMany },
    $transaction: m.transaction,
  },
}))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAudit: m.logAudit }))
vi.mock("./ingest", () => ({ ingestEvent: m.ingestEvent }))

import { pollTenant, runTelematicsPoll } from "./poll"
import { registerTelematicsProvider } from "./registry"
import type { TelematicsProvider } from "./types"

const device = (id: string, externalDeviceId: string, provider = "simulated") =>
  ({ id, tenantId: "t1", assetId: `a-${id}`, provider, externalDeviceId, installedOn: new Date("2026-09-01T00:00:00.000Z"), pollCursor: null, meterVerifiedAt: null })
const NOW = new Date("2026-09-03T18:00:00.000Z")
const updates = () => m.updateMany.mock.calls.map(([args]) => args as { where: { id?: string }; data: Record<string, unknown> })

describe("the telematics poll", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    for (const fn of [m.updateMany, m.transaction, m.ingestEvent, m.logAudit, m.findDevices]) fn.mockClear()
    m.devices = [device("d1", "SIM-STEADY-1")]
  })
  afterEach(() => vi.unstubAllEnvs())

  it("refuses the simulated provider on a deployed build without the allow-list: nothing stored, the device marked, audited", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: false, failed: 1, stored: 0 })
    expect(m.transaction).not.toHaveBeenCalled()
    expect(m.ingestEvent).not.toHaveBeenCalled()
    expect(updates()).toEqual([expect.objectContaining({ data: { lastPollError: expect.stringMatching(/^NOT_CONFIGURED: Simulated simulated-telematics results are not permitted/) } })])
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", action: "TELEMATICS_POLL_FAILED" }))
    expect(await runTelematicsPoll(NOW)).toMatchObject({ ok: false, failed: 1 })
  })

  it("runs it when SIMULATED_INTEGRATIONS names simulated-telematics, storing every event as simulated and moving the cursor", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: true, failed: 0, stored: 9, devices: 1 })
    expect(m.ingestEvent.mock.calls.every(([, , , ctx]) => ctx.simulated)).toBe(true)
    expect(updates().at(-1)).toMatchObject({ where: { id: "d1" }, data: { lastPollError: null, pollCursor: "2026-09-03T16:00:00.000Z" } })
  })

  it("drops a device id the tenant does not have, and keeps a device's cursor when one of its events failed", async () => {
    const stray: TelematicsProvider = {
      id: "test-stray", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({
        simulated: false, cursors: { "DEV-1": "2026-09-03T00:00:00.000Z" },
        events: [
          { providerEventId: "x1", externalDeviceId: "OTHER-TENANTS-DEVICE", occurredAt: NOW, kind: "HEARTBEAT" },
          { providerEventId: "x2", externalDeviceId: "DEV-1", occurredAt: NOW, kind: "HEARTBEAT" },
          { providerEventId: "x3", externalDeviceId: "DEV-1", occurredAt: NOW, kind: "METER" },
        ],
      }),
    }
    registerTelematicsProvider(stray)
    m.devices = [device("d2", "DEV-1", "test-stray")]
    m.ingestEvent.mockImplementationOnce(async () => { throw new Error("boom") })
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ unknownDevices: 1, failed: 1, stored: 0, rejected: 0 })
    expect(m.ingestEvent).toHaveBeenCalledTimes(1) // x3 is malformed (no meter) and never reached: the device failed first
    expect(updates().at(-1)).toMatchObject({ where: { id: "d2" }, data: { lastPollError: expect.stringMatching(/retried/) } })
    expect(updates().at(-1)!.data).not.toHaveProperty("pollCursor")
  })

  it("polls only devices on an asset under an agreement (a running loan, or an approved or contracted deal awaiting payout): collection ends with it", async () => {
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    await pollTenant("t1", NOW)
    expect(m.findDevices.mock.calls[0][0]).toMatchObject({
      where: {
        tenantId: "t1", status: "ACTIVE",
        OR: [{ asset: { loans: { some: { tenantId: "t1", status: { in: ["ACTIVE", "DEFAULTED"] } } } } }, { asset: { deals: { some: { tenantId: "t1", status: { in: ["APPROVED", "CONTRACTED"] } } } } }],
      },
    })
  })

  it("skips, counts and audits an event refused for what it is, and moves the cursor past it; a future event waits", async () => {
    const events = [
      { providerEventId: "bad\u0000id", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "r1", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "ok", externalDeviceId: "DEV-2", occurredAt: NOW, kind: "HEARTBEAT" as const },
      { providerEventId: "soon", externalDeviceId: "DEV-3", occurredAt: new Date(NOW.getTime() + 60_000), kind: "HEARTBEAT" as const },
      { providerEventId: "after", externalDeviceId: "DEV-3", occurredAt: new Date(NOW.getTime() + 61_000), kind: "HEARTBEAT" as const },
    ]
    registerTelematicsProvider({
      id: "test-rules", label: "Test", simulated: false, deviceIdError: () => null, assertUsable: () => undefined,
      poll: async () => ({ simulated: false, cursors: { "DEV-2": "c2", "DEV-3": "c3" }, events }),
    })
    m.devices = [device("d3", "DEV-2", "test-rules"), device("d4", "DEV-3", "test-rules")]
    m.ingestEvent.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Error occurred during query execution: PostgresError { code: \"23514\", message: \"A telematics reading ...\" }"), { name: "PrismaClientUnknownRequestError" })
    })
    const run = await pollTenant("t1", NOW)
    expect(run).toMatchObject({ ok: true, rejected: 2, stored: 1, deferred: 1, failed: 0 })
    expect(m.ingestEvent.mock.calls.map(([, , event]) => event.providerEventId)).toEqual(["r1", "ok"])
    const rejected = m.logAudit.mock.calls.map(([entry]) => entry as { action: string; entityId: string; newValue: Record<string, unknown> })
    expect(rejected).toEqual([
      expect.objectContaining({ action: "TELEMATICS_EVENT_REJECTED", entityId: "d3", newValue: expect.objectContaining({ providerEventId: "bad?id", reason: "provider event id" }) }),
      expect.objectContaining({ action: "TELEMATICS_EVENT_REJECTED", entityId: "d3", newValue: expect.objectContaining({ providerEventId: "r1", reason: "database refused it (23514)" }) }),
    ])
    expect(updates().find((u) => u.where.id === "d3")).toMatchObject({ data: { lastPollError: null, pollCursor: "c2" } })
    const waiting = updates().find((u) => u.where.id === "d4")!
    expect(waiting.data).toMatchObject({ lastPollError: null })
    expect(waiting.data).not.toHaveProperty("pollCursor")
  })
})
