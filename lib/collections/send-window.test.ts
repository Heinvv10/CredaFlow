import { describe, expect, it } from "vitest"
import { DUNNING_SEND_WINDOW_LABEL, outsideDunningSendWindow } from "./send-window"

// Pinned instants, in UTC: SAST is UTC+2 all year.
describe("outsideDunningSendWindow", () => {
  it.each([
    ["2026-10-20T04:59:59Z", true], // 06:59:59 SAST
    ["2026-10-20T05:00:00Z", false], // 07:00 SAST
    ["2026-10-20T12:00:00Z", false], // 14:00 SAST
    ["2026-10-20T17:59:59Z", false], // 19:59:59 SAST
    ["2026-10-20T18:00:00Z", true], // 20:00 SAST
    ["2026-10-20T21:30:00Z", true], // 23:30 SAST
    ["2026-10-20T22:30:00Z", true], // 00:30 SAST the next day
  ])("%s is outside: %s", (iso, outside) => {
    expect(outsideDunningSendWindow(new Date(iso))).toBe(outside)
  })

  it("is labelled with the same hours", () => {
    expect(DUNNING_SEND_WINDOW_LABEL).toBe("07:00-20:00 SAST")
  })
})
