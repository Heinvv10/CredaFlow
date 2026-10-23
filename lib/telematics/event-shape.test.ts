import { describe, expect, it } from "vitest"
import { hasControlCharacter, invalidEvent } from "./event-shape"
import type { NormalisedTelematicsEvent } from "./types"

// An event the database would refuse must be refused here: the poll skips it
// and moves the cursor past it, so one bad event cannot wedge a device.
const NOW = new Date("2026-09-01T10:00:00Z")
const at = { installedOn: "2026-08-01", now: NOW, retentionDays: 90 }
const meter = (value: number): NormalisedTelematicsEvent =>
  ({ externalDeviceId: "D", providerEventId: "e1", kind: "METER", occurredAt: new Date("2026-09-01T10:00:00Z"), meter: { value, unit: "HOURS" } }) as NormalisedTelematicsEvent
const heartbeat = (over: Partial<NormalisedTelematicsEvent> = {}): NormalisedTelematicsEvent =>
  ({ externalDeviceId: "D", providerEventId: "e2", kind: "HEARTBEAT", occurredAt: new Date(NOW.getTime() - 60_000), ...over })

describe("invalidEvent vs the INTEGER columns", () => {
  it("rejects a meter value that does not fit TelematicsEvent.meterValue (INTEGER)", () => {
    expect(invalidEvent(meter(2_147_483_647))).toBeNull()
    expect(invalidEvent(meter(3_000_000_000))).not.toBeNull()
  })

  it("rejects an accuracy that does not fit TelematicsPosition.accuracyM (INTEGER)", () => {
    const position = (accuracyM: number) => heartbeat({ kind: "POSITION", position: { latitude: -26, longitude: 28, accuracyM } })
    expect(invalidEvent(position(2_147_483_647))).toBeNull()
    expect(invalidEvent(position(2_147_483_648))).toBe("position")
    expect(invalidEvent(position(1.5))).toBe("position")
  })
})

describe("invalidEvent vs the text and time rules", () => {
  it("rejects a control character in the provider's event id (Postgres refuses a NUL outright)", () => {
    expect(invalidEvent(heartbeat({ providerEventId: "bad\u0000id" }))).toBe("provider event id")
    expect(invalidEvent(heartbeat({ providerEventId: "tab\tid" }))).toBe("provider event id")
    expect(invalidEvent(heartbeat({ providerEventId: "é-ü-ñ" }))).toBeNull()
    expect(hasControlCharacter("SIM-STEADY-1")).toBe(false)
    expect(hasControlCharacter("x\u007f")).toBe(true)
  })

  it("rejects an event dated before the installation (SAST) or more than five minutes ahead of the poll", () => {
    // 21:59 UTC on 31 July is 23:59 SAST on 31 July, the day before the installation; 22:00 UTC is 1 August SAST.
    expect(invalidEvent(heartbeat({ occurredAt: new Date("2026-07-31T21:59:59.999Z") }), at)).toBe("before the installation")
    expect(invalidEvent(heartbeat({ occurredAt: new Date("2026-07-31T22:00:00.000Z") }), at)).toBeNull()
    expect(invalidEvent(heartbeat({ occurredAt: new Date(NOW.getTime() + 5 * 60_000) }), at)).toBeNull()
    expect(invalidEvent(heartbeat({ occurredAt: new Date(NOW.getTime() + 5 * 60_000 + 1) }), at)).toBe("more than five minutes ahead")
    // Older than the tenant's retention (a purged event delivered again): refused, a minute's margin for the database's clock.
    const DAY = 86_400_000
    expect(invalidEvent(heartbeat({ occurredAt: new Date(NOW.getTime() - 10 * DAY + 61_000) }), { ...at, installedOn: "2026-01-01", retentionDays: 10 })).toBeNull()
    expect(invalidEvent(heartbeat({ occurredAt: new Date(NOW.getTime() - 10 * DAY + 59_000) }), { ...at, installedOn: "2026-01-01", retentionDays: 10 })).toBe("older than the retention")
    // Without the device's context only the shape is checked.
    expect(invalidEvent(heartbeat({ occurredAt: new Date("2020-01-01T00:00:00Z") }))).toBeNull()
  })
})
