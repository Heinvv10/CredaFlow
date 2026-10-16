import { describe, expect, it } from "vitest"
import { ncrHistoryNote, ncrPositionBasis } from "./ncr-position-basis"

const fmt = (d: Date) => d.toISOString().slice(0, 10)

describe("ncrPositionBasis", () => {
  it("names the history day when the position comes from it", () => {
    expect(ncrPositionBasis({ positionSource: "SNAPSHOT", positionAsOf: new Date("2026-09-30T00:00:00Z"), positionIsStale: false }, false, fmt))
      .toBe("Position at quarter end: the book as at 2026-09-30, from the daily arrears history")
  })

  it("keeps the stale warning without history, and the filed wording once filed", () => {
    expect(ncrPositionBasis({ positionSource: "LIVE", positionAsOf: null, positionIsStale: true }, false, fmt))
      .toBe("Position lines reflect the book today, NOT the quarter end")
    expect(ncrPositionBasis({ positionSource: "SNAPSHOT", positionAsOf: new Date(), positionIsStale: false }, true, fmt))
      .toBe("Position lines are the figures frozen at submission")
  })
})

describe("ncrHistoryNote", () => {
  const q3End = new Date("2026-09-30T21:59:59.999Z")
  it("says history has not started and is not backfilled", () => {
    expect(ncrHistoryNote(null, q3End, fmt)).toContain("not backfilled")
  })

  it("tells history that began after the quarter from a missing quarter-end day", () => {
    expect(ncrHistoryNote(new Date("2026-10-17T00:00:00Z"), q3End, fmt)).toBe("Daily arrears history starts on 2026-10-17, after this quarter ended; it is not backfilled.")
    expect(ncrHistoryNote(new Date("2026-09-01T00:00:00Z"), q3End, fmt)).toBe("No arrears snapshot was recorded on the quarter's last day (2026-09-30), although history starts on 2026-09-01.")
  })

  it("counts history that began on the quarter's last day as covering it", () => {
    expect(ncrHistoryNote(new Date("2026-09-30T00:00:00Z"), q3End, fmt)).toContain("No arrears snapshot was recorded")
  })
})
