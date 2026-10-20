import { describe, expect, it } from "vitest"
import { dunningRetryVerdict, nextDunningWindowStart } from "./dunning-window"

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
    expect(dunningRetryVerdict(at("2026-11-03T00:30:00Z"), at(now), true)).toBe(verdict)
  })

  it("expires a message that was not sent by the end of its SAST creation day, at any hour: it would say 'due TOMORROW' a day late", () => {
    const created = at("2026-11-03T08:00:00Z") // 10:00 SAST on the 3rd
    expect(dunningRetryVerdict(created, at("2026-11-03T22:30:00Z"), true)).toBe("expire") // 00:30 SAST on the 4th
    expect(dunningRetryVerdict(created, at("2026-11-04T03:00:00Z"), true)).toBe("expire") // 05:00, a stalled timer flushing
    expect(dunningRetryVerdict(created, at("2026-11-04T09:00:00Z"), true)).toBe("expire") // 11:00, in the window, but stale
  })

  it("keys the day in SAST, not UTC: created 23:30 SAST is still the same day at 23:50 SAST", () => {
    expect(dunningRetryVerdict(at("2026-11-03T21:30:00Z"), at("2026-11-03T21:50:00Z"), true)).toBe("wait")
  })
})

// A staff reminder and a 60-DPD notice do not go stale at midnight: their wording is not "due TOMORROW".
// They wait out the night and go in the next window; the retry sweep's own 24 hour expiry is their limit.
describe("a dunning message that does not expire at the end of its day", () => {
  const created = at("2026-11-03T08:00:00Z") // 10:00 SAST on the 3rd

  it.each([
    ["22:30 SAST the same day", "2026-11-03T20:30:00Z", "wait"],
    ["05:00 SAST the next day", "2026-11-04T03:00:00Z", "wait"],
    ["11:00 SAST the next day", "2026-11-04T09:00:00Z", "send"],
    ["19:59 SAST the next day, the last minute of the window it gets", "2026-11-04T17:59:00Z", "send"],
    ["20:00 SAST the next day: that window is over, so it expires", "2026-11-04T18:00:00Z", "expire"],
    ["05:00 SAST two days on", "2026-11-05T03:00:00Z", "expire"],
  ])("%s -> %s", (_name, now, verdict) => {
    expect(dunningRetryVerdict(created, at(now), false)).toBe(verdict)
  })
})

describe("nextDunningWindowStart", () => {
  it.each([
    ["04:00 SAST: this morning's 07:00", "2026-11-03T02:00:00Z", "2026-11-03T05:00:00.000Z"],
    ["06:59 SAST", "2026-11-03T04:59:00Z", "2026-11-03T05:00:00.000Z"],
    ["22:30 SAST: tomorrow's 07:00", "2026-11-03T20:30:00Z", "2026-11-04T05:00:00.000Z"],
    ["00:30 SAST: that morning's 07:00, a UTC day earlier", "2026-11-03T22:30:00Z", "2026-11-04T05:00:00.000Z"],
  ])("%s", (_name, now, expected) => {
    expect(nextDunningWindowStart(at(now)).toISOString()).toBe(expected)
  })
})
