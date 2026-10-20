import type { NormalisedTelematicsEvent } from "./types"

/** Why a provider event cannot be stored as it is, or null. */
export function invalidEvent(event: NormalisedTelematicsEvent): string | null {
  if (!event.providerEventId || event.providerEventId.length > 200) return "provider event id"
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) return "time"
  if ((event.kind === "METER") !== (event.meter !== undefined)) return "meter"
  if (event.meter && (!Number.isSafeInteger(event.meter.value) || event.meter.value < 0)) return "meter value"
  if ((event.kind === "IGNITION") !== (event.ignitionOn !== undefined)) return "ignition"
  if ((event.kind === "ALERT") !== (event.alert !== undefined)) return "alert"
  const p = event.position
  if (p && (event.kind === "HEARTBEAT" || event.kind === "METER" || event.kind === "IGNITION")) return "position on a non-position event"
  if (p && !(Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180 && (p.accuracyM === null || p.accuracyM >= 0))) return "position"
  return null
}
