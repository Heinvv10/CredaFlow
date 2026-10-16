import { describe, expect, it } from "vitest"
import { ncrHistoryNote, ncrPositionBasis } from "./ncr-position-basis"

const fmt = (d: Date) => d.toISOString().slice(0, 10)

describe("ncrPositionBasis", () => {
  it("names the history day when the position comes from it", () => {
    expect(ncrPositionBasis({ positionSource: "SNAPSHOT", positionAsOf: new Date("2026-09-30T00:00:00Z"), positionIsStale: false }, false, fmt))
      .toBe("Position lines are the book as at 2026-09-30, from the daily arrears history")
  })

  it("keeps the stale warning without history, and the filed wording once filed", () => {
    expect(ncrPositionBasis({ positionSource: "LIVE", positionAsOf: null, positionIsStale: true }, false, fmt))
      .toBe("Position lines reflect the book today, NOT the quarter end")
    expect(ncrPositionBasis({ positionSource: "SNAPSHOT", positionAsOf: new Date(), positionIsStale: false }, true, fmt))
      .toBe("Position lines are the figures frozen at submission")
  })
})

describe("ncrHistoryNote", () => {
  it("says where history starts, and that it is not backfilled", () => {
    expect(ncrHistoryNote(new Date("2026-10-17T00:00:00Z"), fmt)).toContain("starts on 2026-10-17")
    expect(ncrHistoryNote(null, fmt)).toContain("not backfilled")
  })
})
