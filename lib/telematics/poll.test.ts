import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  devices: [] as Array<Record<string, unknown>>,
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  ingestEvent: vi.fn(async (_tx: unknown, _device: unknown, _event: { providerEventId: string }, _ctx: { simulated: boolean }) => ({ stored: true })),
  logAudit: vi.fn(async (_entry: unknown) => undefined),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: vi.fn(async () => ({ telematicsPositionRetentionDays: 90 })), findMany: vi.fn(async () => [{ tenantId: "t1" }]) },
    trackerDevice: { findMany: vi.fn(async () => m.devices), updateMany: m.updateMany },
    $transaction: m.transaction,
  },
}))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAudit: m.logAudit }))
vi.mock("./ingest", () => ({ ingestEvent: m.ingestEvent }))

import { pollTenant, runTelematicsPoll } from "./poll"
import { registerTelematicsProvider } from "./registry"
import type { TelematicsProvider } from "./types"

const device = (id: string, externalDeviceId: string, provider = "simulated") =>
  ({ id, tenantId: "t1", assetId: `a-${id}`, provider, externalDeviceId, installedOn: new Date("2026-09-01T00:00:00.000Z"), pollCursor: null })
const NOW = new Date("2026-09-03T18:00:00.000Z")
const updates = () => m.updateMany.mock.calls.map(([args]) => args as { where: { id?: string }; data: Record<string, unknown> })

describe("the telematics poll", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    for (const fn of [m.updateMany, m.transaction, m.ingestEvent, m.logAudit]) fn.mockClear()
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
    expect(run).toMatchObject({ unknownDevices: 1, failed: 1, stored: 0 })
    expect(m.ingestEvent).toHaveBeenCalledTimes(1) // x3 is malformed (no meter) and never reached: the device failed first
    expect(updates().at(-1)).toMatchObject({ where: { id: "d2" }, data: { lastPollError: expect.stringMatching(/retried/) } })
    expect(updates().at(-1)!.data).not.toHaveProperty("pollCursor")
  })
})
