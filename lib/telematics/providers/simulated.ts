/**
 * Simulated tracker provider: never leaves the process. For local
 * development, tests and the demo stacks only. Each poll and each device
 * registration checks the simulation guard at invocation time; refused, it is
 * a TelematicsProviderError NOT_CONFIGURED and nothing is answered. Every
 * result carries `simulated: true` (the ingest stores it on every event).
 * Timelines: __fixtures__/simulated-telematics-scenarios.ts.
 */
import { createHash } from "node:crypto"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"
import { SAST_OFFSET_MS } from "@/lib/date/sast"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import {
  DEVICE_ID_PATTERN, HOUR_OF, MAX_OFFSET_DEGREES, ORIGIN, SCENARIO_ALERTS, scenarioMeter, scenarioReports, type SimulatedScenario,
} from "../__fixtures__/simulated-telematics-scenarios"
import { TelematicsProviderError, type NormalisedTelematicsEvent, type TelematicsPollDevice, type TelematicsProvider } from "../types"

export const SIMULATED_TELEMATICS_ID = "simulated"
/** At most this many events per device per poll; the next poll pages on from the cursor. */
export const SIMULATED_PAGE_SIZE = 500
const DAY_MS = 86_400_000

function guard(): void {
  try {
    assertSimulationAllowed("simulated-telematics", true)
  } catch (error) {
    throw new TelematicsProviderError("NOT_CONFIGURED", error instanceof Error ? error.message : "Simulation refused")
  }
}

/** The UTC instant of `hour`:00 SAST on day `day` after `installedOn`. */
const at = (installedOn: string, day: number, hour: number) =>
  new Date((toDayNumber(installedOn) + day) * DAY_MS + hour * 3_600_000 - SAST_OFFSET_MS)

function position(externalDeviceId: string, day: number, hour: number) {
  const digest = createHash("sha256").update(`${externalDeviceId}:${day}:${hour}`).digest()
  const offset = (byte: number) => Math.round(((digest.readUInt16BE(byte) / 65_536) * MAX_OFFSET_DEGREES) * 1e6) / 1e6
  return { latitude: Math.round((ORIGIN.latitude - offset(0)) * 1e6) / 1e6, longitude: Math.round((ORIGIN.longitude + offset(2)) * 1e6) / 1e6, accuracyM: 10 }
}

function dayEvents(externalDeviceId: string, scenario: SimulatedScenario, installedOn: string, day: number): NormalisedTelematicsEvent[] {
  if (!scenarioReports(scenario, day)) return []
  // The installation date is part of the id: a device id re-registered later must not replay the old installation's ids.
  const id = (suffix: string) => `sim:${externalDeviceId}:${installedOn}:${day}:${suffix}`
  const events: NormalisedTelematicsEvent[] = [
    { providerEventId: id("HEARTBEAT"), externalDeviceId, occurredAt: at(installedOn, day, HOUR_OF.HEARTBEAT), kind: "HEARTBEAT" },
    { providerEventId: id("POSITION"), externalDeviceId, occurredAt: at(installedOn, day, HOUR_OF.POSITION), kind: "POSITION", position: position(externalDeviceId, day, HOUR_OF.POSITION) },
    { providerEventId: id("METER"), externalDeviceId, occurredAt: at(installedOn, day, HOUR_OF.METER), kind: "METER", meter: { value: scenarioMeter(scenario, day), unit: "HOURS" } },
  ]
  for (const scripted of SCENARIO_ALERTS[scenario].filter((a) => a.day === day)) {
    events.push({
      providerEventId: id(`ALERT:${scripted.alert}`), externalDeviceId, occurredAt: at(installedOn, day, scripted.hour), kind: "ALERT", alert: scripted.alert,
      ...(scripted.withPosition ? { position: position(externalDeviceId, day, scripted.hour) } : {}),
    })
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
}

function deviceEvents(device: TelematicsPollDevice, now: Date): NormalisedTelematicsEvent[] {
  const match = DEVICE_ID_PATTERN.exec(device.externalDeviceId)
  if (!match) return []
  const scenario = match[1] as SimulatedScenario
  const after = device.cursor ? new Date(device.cursor).getTime() : -Infinity
  if (Number.isNaN(after)) throw new TelematicsProviderError("BAD_RESPONSE", `Unreadable cursor for ${device.externalDeviceId}`)
  const installed = toDayNumber(device.installedOn)
  const firstDay = Math.max(0, Number.isFinite(after) ? Math.floor((after + SAST_OFFSET_MS) / DAY_MS) - installed : 0)
  const lastDay = Math.floor((now.getTime() + SAST_OFFSET_MS) / DAY_MS) - installed
  const out: NormalisedTelematicsEvent[] = []
  for (let day = firstDay; day <= lastDay && out.length < SIMULATED_PAGE_SIZE; day++) {
    for (const event of dayEvents(device.externalDeviceId, scenario, fromDayNumber(installed), day)) {
      const t = event.occurredAt.getTime()
      if (t > after && t <= now.getTime() && out.length < SIMULATED_PAGE_SIZE) out.push(event)
    }
  }
  return out
}

export const simulatedTelematics: TelematicsProvider = {
  id: SIMULATED_TELEMATICS_ID,
  label: "Simulated tracker",
  simulated: true,
  deviceIdError: (externalDeviceId) =>
    DEVICE_ID_PATTERN.test(externalDeviceId) ? null : "A simulated device id is SIM-<SCENARIO>-<n> (STEADY, TAMPER, GEOFENCE, ROLLBACK, SPIKE or SILENT)",
  assertUsable: guard,
  async poll({ devices, now }) {
    guard()
    const events: NormalisedTelematicsEvent[] = []
    const cursors: Record<string, string> = {}
    for (const device of devices) {
      const mine = deviceEvents(device, now)
      if (mine.length > 0) cursors[device.externalDeviceId] = mine[mine.length - 1].occurredAt.toISOString()
      events.push(...mine)
    }
    return { events, cursors, simulated: true, simulationSource: "simulated-telematics" }
  },
}
