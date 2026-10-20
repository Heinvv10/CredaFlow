import { describe, expect, it } from "vitest"
import { dunningRetryVerdict } from "./dunning-window"

// SAST is UTC+2, so 05:00Z is 07:00 and 18:00Z is 20:00.
const at = (iso: string) => new Date(iso)

describe("dunningRetryVerdict", () => {
  it.each([
    ["07:00 SAST sharp", "2026-11-03T05:00:00Z", "send"],
    ["midday", "2026-11-03T10:00:00Z", "send"],
    ["19:59 SAST", "2026-11-03T17:59:00Z", "send"],
    ["20:00 SAST sharp", "2026-11-03T18:00:00Z", "wait"],
    ["22:30 SAST", "2026-11-03T20:30:00Z", "wait"],
    ["04:00 SAST, a late first failure whose last retry falls after midnight", "2026-11-03T02:00:00Z", "wait"],
    ["06:59 SAST", "2026-11-03T04:59:00Z", "wait"],
  ])("a message created this SAST day is sent only 07:00-20:00: %s -> %s", (_name, now, verdict) => {
    // Created on the same SAST day, at 02:30 SAST.
    expect(dunningRetryVerdict(at("2026-11-03T00:30:00Z"), at(now))).toBe(verdict)
  })

  it("expires a message that was not sent by the end of its SAST creation day, at any hour: it would say 'due TOMORROW' a day late", () => {
    const created = at("2026-11-03T08:00:00Z") // 10:00 SAST on the 3rd
    expect(dunningRetryVerdict(created, at("2026-11-03T22:30:00Z"))).toBe("expire") // 00:30 SAST on the 4th
    expect(dunningRetryVerdict(created, at("2026-11-04T03:00:00Z"))).toBe("expire") // 05:00, a stalled timer flushing
    expect(dunningRetryVerdict(created, at("2026-11-04T09:00:00Z"))).toBe("expire") // 11:00, in the window, but stale
  })

  it("keys the day in SAST, not UTC: created 23:30 SAST is still the same day at 23:50 SAST", () => {
    expect(dunningRetryVerdict(at("2026-11-03T21:30:00Z"), at("2026-11-03T21:50:00Z"))).toBe("wait")
  })
})
