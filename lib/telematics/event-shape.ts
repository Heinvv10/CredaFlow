import { sastCalendarDate } from "@/lib/date/sast"
import type { NormalisedTelematicsEvent } from "./types"

/** The database's INTEGER (int4) columns: TelematicsEvent.meterValue, TelematicsPosition.accuracyM. */
const INT4_MAX = 2_147_483_647
/** How far ahead of the database's clock an event may be stored (guardTelematicsEvent). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000
const DAY_MS = 86_400_000
/** An event this close to the retention edge is refused here: the database's clock may already be past it. */
const RETENTION_EDGE_MS = 60_000
/** True when a provider or device id carries a control character (a NUL the database refuses outright). */
export const hasControlCharacter = (value: string): boolean => [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

const int4 = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= INT4_MAX

/**
 * Why a provider event cannot be stored as it is, or null. With the device's
 * installation day, the poll's clock and the tenant's retention it also
 * refuses an event dated before the installation (SAST), more than five
 * minutes ahead, or older than the retention (a purged event delivered again
 * is not new): the database would refuse each, every poll.
 */
export function invalidEvent(event: NormalisedTelematicsEvent, at?: { installedOn: string; now: Date; retentionDays: number }): string | null {
  if (!event.providerEventId || event.providerEventId.length > 200 || hasControlCharacter(event.providerEventId)) return "provider event id"
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) return "time"
  if (at && sastCalendarDate(event.occurredAt) < at.installedOn) return "before the installation"
  if (at && event.occurredAt.getTime() > at.now.getTime() + FUTURE_TOLERANCE_MS) return "more than five minutes ahead"
  if (at && event.occurredAt.getTime() < at.now.getTime() - at.retentionDays * DAY_MS + RETENTION_EDGE_MS) return "older than the retention"
  if ((event.kind === "METER") !== (event.meter !== undefined)) return "meter"
  if (event.meter && !int4(event.meter.value)) return "meter value"
  if ((event.kind === "IGNITION") !== (event.ignitionOn !== undefined)) return "ignition"
  if ((event.kind === "ALERT") !== (event.alert !== undefined)) return "alert"
  const p = event.position
  if (p && (event.kind === "HEARTBEAT" || event.kind === "METER" || event.kind === "IGNITION")) return "position on a non-position event"
  if (p && !(Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180 && (p.accuracyM === null || int4(p.accuracyM)))) return "position"
  return null
}

/** The database refused the event as not yet due (SQLSTATE 55000: its clock is behind the poll's): the poll defers it. */
export class TelematicsEventNotYet extends Error {
  constructor() {
    super("the database's clock has not reached the event yet")
    this.name = "TelematicsEventNotYet"
  }
}

/** An event refused for what it is, not for a passing failure: the poll skips it and moves on. */
export class TelematicsEventRejected extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "TelematicsEventRejected"
  }
}
