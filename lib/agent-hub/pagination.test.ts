import { describe, it, expect } from "vitest"
import { parsePage, pageOffsets, totalPages, clampPage } from "./pagination"

describe("parsePage", () => {
  it("defaults to 1 when the param is absent", () => {
    expect(parsePage(undefined)).toBe(1)
  })

  it("defaults to 1 for a non-numeric value rather than throwing", () => {
    expect(parsePage("abc")).toBe(1)
  })

  it("defaults to 1 for zero or a negative page", () => {
    expect(parsePage("0")).toBe(1)
    expect(parsePage("-3")).toBe(1)
  })

  it("defaults to 1 for a non-integer page", () => {
    expect(parsePage("2.5")).toBe(1)
  })

  it("parses a valid page number", () => {
    expect(parsePage("3")).toBe(3)
  })
})

describe("pageOffsets", () => {
  it("computes skip 0 for page 1", () => {
    expect(pageOffsets(1, 25)).toEqual({ skip: 0, take: 25 })
  })

  it("computes skip for a later page", () => {
    expect(pageOffsets(3, 25)).toEqual({ skip: 50, take: 25 })
  })
})

describe("totalPages", () => {
  it("is 1 even with zero rows, never 0 (a queue with nothing pending still has one, empty page)", () => {
    expect(totalPages(0, 25)).toBe(1)
  })

  it("rounds up a partial page", () => {
    expect(totalPages(26, 25)).toBe(2)
  })

  it("does not add an extra page for an exact multiple", () => {
    expect(totalPages(50, 25)).toBe(2)
  })
})

// An unclamped page produced a nonsensical
// footer ("Page 99 of 1") and an empty table after a stale bookmark or
// hand-edited ?page= outlived a shrinking result set. Each case below targets
// a distinct mutant so a future regression can't slip through by only
// exercising the one case an earlier pass happened to pick.
describe("clampPage", () => {
  it("returns the page unchanged when it is within range", () => {
    expect(clampPage(3, 5)).toBe(3)
  })

  it("returns the page unchanged at the exact upper boundary (no off-by-one)", () => {
    expect(clampPage(5, 5)).toBe(5)
  })

  it("clamps a page far past the end down to the last real page", () => {
    expect(clampPage(99, 5)).toBe(5)
  })

  it("clamps a page one past the end down to the last real page", () => {
    expect(clampPage(6, 5)).toBe(5)
  })

  it("clamps down to 1 when there is only one page total", () => {
    expect(clampPage(4, 1)).toBe(1)
  })

  // Guards the lower bound independently of the upper-bound case above — a
  // mutant that only clamps downward (min, never max) would pass every test
  // up to this point.
  it("clamps a page below 1 up to 1, not down toward totalPages", () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(-3, 5)).toBe(1)
  })

  it("returns 1 when both page and totalPages are 1", () => {
    expect(clampPage(1, 1)).toBe(1)
  })
})
