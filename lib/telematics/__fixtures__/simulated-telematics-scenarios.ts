/**
 * The simulated tracker's scenarios. A device's timeline is a pure function of
 * (externalDeviceId, installedOn, now): the simulator keeps no state, so a
 * re-poll answers the same event ids and a demo or a test is reproducible.
 *
 * The device id `SIM-<SCENARIO>-<n>` picks the scenario. Day d after the
 * installation (SAST) has a HEARTBEAT at 06:00, a POSITION at 12:00 and a
 * METER (hours) at 18:00. Positions are a fixed point in the sea south of
 * Cape Agulhas plus an offset under 0.05 degrees: obviously not a real yard.
 * All values are synthetic.
 */
import type { TelematicsAlertKind } from "@prisma/client"

export const SIMULATED_SCENARIOS = ["STEADY", "TAMPER", "GEOFENCE", "ROLLBACK", "SPIKE", "SILENT"] as const
export type SimulatedScenario = (typeof SIMULATED_SCENARIOS)[number]

export const DEVICE_ID_PATTERN = /^SIM-(STEADY|TAMPER|GEOFENCE|ROLLBACK|SPIKE|SILENT)-\d{1,6}$/

/** STEADY: 6 h a day from 1 000 h, 2 190 h a year: over a 1 500 h allowance, so a projected excess shows. */
export const START_HOURS = 1_000
export const HOURS_PER_DAY = 6

export const ORIGIN = { latitude: -35, longitude: 20 } as const
export const MAX_OFFSET_DEGREES = 0.05

/** SAST wall-clock hours of the daily events. */
export const HOUR_OF = { HEARTBEAT: 6, POSITION: 12, METER: 18 } as const

export interface ScriptedAlert {
  day: number
  hour: number
  alert: TelematicsAlertKind
  withPosition: boolean
}

export const SCENARIO_ALERTS: Readonly<Record<SimulatedScenario, readonly ScriptedAlert[]>> = Object.freeze({
  STEADY: [],
  TAMPER: [{ day: 25, hour: 19, alert: "TAMPER", withPosition: false }, { day: 26, hour: 19, alert: "POWER_CUT", withPosition: false }],
  GEOFENCE: [{ day: 20, hour: 15, alert: "GEOFENCE_EXIT", withPosition: true }],
  ROLLBACK: [],
  SPIKE: [],
  SILENT: [],
})

/** The meter on day d, as the scenario reads it. */
export function scenarioMeter(scenario: SimulatedScenario, day: number): number {
  const steady = START_HOURS + HOURS_PER_DAY * day
  if (scenario === "ROLLBACK" && day === 15) return steady - 200
  if (scenario === "SPIKE" && day === 10) return steady + 50_000
  return steady
}

/** SILENT stops reporting after day 5. */
export function scenarioReports(scenario: SimulatedScenario, day: number): boolean {
  return scenario !== "SILENT" || day <= 5
}
