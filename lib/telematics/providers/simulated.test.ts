import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getTelematicsProvider } from "../registry"
import { TelematicsProviderError, type NormalisedTelematicsEvent } from "../types"
import { SIMULATED_TELEMATICS_ID, simulatedTelematics } from "./simulated"

// Installed 2026-09-01 (SAST); "now" is day 30 at 20:00 SAST.
const INSTALLED = "2026-09-01"
const NOW = new Date("2026-10-01T18:00:00.000Z")
const device = (externalDeviceId: string, cursor: string | null = null) => ({ externalDeviceId, cursor, installedOn: INSTALLED })
const poll = (devices: ReturnType<typeof device>[], now = NOW) => simulatedTelematics.poll({ devices, now })
const meters = (events: NormalisedTelematicsEvent[]) => events.filter((e) => e.kind === "METER").map((e) => e.meter!.value)

describe("simulated telematics provider", () => {
  beforeEach(() => vi.unstubAllEnvs())
  afterEach(() => vi.unstubAllEnvs())

  it("is registered under 'simulated' and labelled simulated", () => {
    expect(getTelematicsProvider(SIMULATED_TELEMATICS_ID)).toBe(simulatedTelematics)
    expect(simulatedTelematics.simulated).toBe(true)
  })

  it("refuses to poll on a deployed build that does not name it in SIMULATED_INTEGRATIONS, and to be registered", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(poll([device("SIM-STEADY-1")])).rejects.toMatchObject({ name: "TelematicsProviderError", code: "NOT_CONFIGURED" })
    expect(() => simulatedTelematics.assertUsable()).toThrow(TelematicsProviderError)
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections")
    expect(() => simulatedTelematics.assertUsable()).toThrow(/not permitted on a deployed build/)
  })

  it("runs on a deployed build that names simulated-telematics, and labels every result and event", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections, simulated-telematics")
    expect(() => simulatedTelematics.assertUsable()).not.toThrow()
    const result = await poll([device("SIM-STEADY-1")])
    expect(result).toMatchObject({ simulated: true, simulationSource: "simulated-telematics" })
    expect(result.events.length).toBeGreaterThan(0)
  })

  it("accepts only SIM-<SCENARIO>-<n> device ids", () => {
    expect(simulatedTelematics.deviceIdError("SIM-TAMPER-0001")).toBeNull()
    expect(simulatedTelematics.deviceIdError("SIM-NOPE-1")).toMatch(/SIM-<SCENARIO>-<n>/)
    expect(simulatedTelematics.deviceIdError("TRK-123")).toMatch(/SIM-<SCENARIO>-<n>/)
  })

  it("emits a heartbeat at 06:00, a position at 12:00 and a meter at 18:00 SAST each day, deterministically", async () => {
    const { events, cursors } = await poll([device("SIM-STEADY-7")])
    const day0 = events.filter((e) => e.providerEventId.startsWith("sim:SIM-STEADY-7:0:"))
    expect(day0.map((e) => [e.kind, e.occurredAt.toISOString()])).toEqual([
      ["HEARTBEAT", "2026-09-01T04:00:00.000Z"], ["POSITION", "2026-09-01T10:00:00.000Z"], ["METER", "2026-09-01T16:00:00.000Z"],
    ])
    // Days 0 to 30: day 30 (1 Oct) is polled at 20:00 SAST, after its 18:00 meter.
    expect(events).toHaveLength(31 * 3)
    expect(meters(events).slice(0, 3)).toEqual([1_000, 1_006, 1_012])
    expect(events.every((e) => e.externalDeviceId === "SIM-STEADY-7")).toBe(true)
    const position = events.find((e) => e.kind === "POSITION")!.position!
    expect(Math.abs(position.latitude - -35)).toBeLessThan(0.05)
    expect(Math.abs(position.longitude - 20)).toBeLessThan(0.05)
    expect(cursors["SIM-STEADY-7"]).toBe(events.at(-1)!.occurredAt.toISOString())
    expect(await poll([device("SIM-STEADY-7")])).toEqual({ events, cursors, simulated: true, simulationSource: "simulated-telematics" })
  })

  it("pages from the cursor without gaps or repeats, at most 500 events per device", async () => {
    const later = new Date("2027-03-01T18:00:00.000Z")
    const all: NormalisedTelematicsEvent[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const { events, cursors } = await poll([device("SIM-STEADY-2", cursor)], later)
      expect(events.length).toBeLessThanOrEqual(500)
      all.push(...events)
      if (!cursors["SIM-STEADY-2"]) break
      cursor = cursors["SIM-STEADY-2"]
    }
    const ids = all.map((e) => e.providerEventId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(all).toHaveLength(182 * 3) // 2026-09-01 .. 2027-03-01 inclusive: two pages
    const times = all.map((e) => e.occurredAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it("plays each scenario: tamper and power cut, geofence exit with a position, a rollback, a spike, silence", async () => {
    const { events } = await poll(["SIM-TAMPER-1", "SIM-GEOFENCE-1", "SIM-ROLLBACK-1", "SIM-SPIKE-1", "SIM-SILENT-1"].map((id) => device(id)))
    const of = (id: string) => events.filter((e) => e.externalDeviceId === id)
    expect(of("SIM-TAMPER-1").filter((e) => e.kind === "ALERT").map((e) => [e.alert, e.providerEventId, e.occurredAt.toISOString()])).toEqual([
      ["TAMPER", "sim:SIM-TAMPER-1:25:ALERT:TAMPER", "2026-09-26T17:00:00.000Z"],
      ["POWER_CUT", "sim:SIM-TAMPER-1:26:ALERT:POWER_CUT", "2026-09-27T17:00:00.000Z"],
    ])
    const geofence = of("SIM-GEOFENCE-1").filter((e) => e.kind === "ALERT")
    expect(geofence.map((e) => e.alert)).toEqual(["GEOFENCE_EXIT"])
    expect(geofence[0].position).toBeDefined()
    expect(meters(of("SIM-ROLLBACK-1"))[15]).toBe(1_000 + 6 * 15 - 200)
    expect(meters(of("SIM-SPIKE-1"))[10]).toBe(1_000 + 6 * 10 + 50_000)
    expect(meters(of("SIM-SPIKE-1"))[11]).toBe(1_000 + 6 * 11)
    expect(of("SIM-SILENT-1")).toHaveLength(6 * 3)
  })
})
