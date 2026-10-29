import { SIMULATION_MAX_DAYS, SIMULATION_MAX_LIMIT } from "./simulate"

export type SimulationWindow = { ok: true; sinceDays: number | undefined; limit: number | undefined } | { ok: false; error: string }

const whole = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max

/** The window an untrusted request asks a simulation to cover: absent, or whole numbers within bounds; anything else is a 400. */
export function parseSimulationWindow(body: { sinceDays?: unknown; limit?: unknown }): SimulationWindow {
  if ("sinceDays" in body && body.sinceDays !== undefined && !whole(body.sinceDays, SIMULATION_MAX_DAYS)) {
    return { ok: false, error: `sinceDays must be a whole number from 1 to ${SIMULATION_MAX_DAYS}` }
  }
  if ("limit" in body && body.limit !== undefined && !whole(body.limit, SIMULATION_MAX_LIMIT)) {
    return { ok: false, error: `limit must be a whole number from 1 to ${SIMULATION_MAX_LIMIT}` }
  }
  return { ok: true, sinceDays: body.sinceDays as number | undefined, limit: body.limit as number | undefined }
}
