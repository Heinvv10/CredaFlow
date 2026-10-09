import { describe, expect, it } from "vitest"
import {
  MAX_QUOTE_FRAME_HEIGHT,
  MIN_QUOTE_FRAME_HEIGHT,
  resolveQuoteFrameDirty,
  resolveQuoteFrameHeight,
} from "./quickquote-frame-message"

const ORIGIN = "https://quote.lender.example"
const FRAME = { name: "the-frame-content-window" }

function message(over: Record<string, unknown> = {}) {
  return {
    origin: ORIGIN,
    source: FRAME,
    data: { type: "lms:quote-height", height: 1200 },
    expectedOrigin: ORIGIN,
    expectedSource: FRAME,
    ...over,
  }
}

describe("resolveQuoteFrameHeight", () => {
  it("accepts a well-formed message from the expected frame", () => {
    expect(resolveQuoteFrameHeight(message())).toBe(1200)
  })

  // The guard between the trusted frame and every other window on the page.
  it.each([
    "https://evil.example",
    "https://lender.example",
    "https://quote.lender.example.evil.example",
    "http://quote.lender.example",
    "null",
    "",
  ])("ignores a message from the origin %o", (origin) => {
    expect(resolveQuoteFrameHeight(message({ origin }))).toBeNull()
  })

  // The sandbox permits popups, so a window opened on the quote origin passes
  // an origin-only check while not being the frame.
  it("ignores a right-origin message from a different window", () => {
    expect(
      resolveQuoteFrameHeight(message({ source: { name: "a-popup" } })),
    ).toBeNull()
  })

  it.each([null, undefined])(
    "ignores every message while the frame is unmounted (expectedSource %o)",
    (expectedSource) => {
      expect(
        resolveQuoteFrameHeight(message({ expectedSource, source: expectedSource })),
      ).toBeNull()
    },
  )

  it("ignores a message when no expected origin is configured", () => {
    expect(
      resolveQuoteFrameHeight(message({ expectedOrigin: "", origin: "" })),
    ).toBeNull()
  })

  it.each([
    { type: "something:else", height: 1200 },
    { height: 1200 },
    { type: "lms:quote-height" },
    { type: "lms:quote-height", height: "1200" },
    { type: "lms:quote-height", height: Number.NaN },
    { type: "lms:quote-height", height: Number.POSITIVE_INFINITY },
    null,
    "lms:quote-height",
    42,
  ])("ignores the malformed payload %o", (data) => {
    expect(resolveQuoteFrameHeight(message({ data }))).toBeNull()
  })

  it("clamps below the floor up to the minimum", () => {
    expect(
      resolveQuoteFrameHeight(message({ data: { type: "lms:quote-height", height: 10 } })),
    ).toBe(MIN_QUOTE_FRAME_HEIGHT)
  })

  it.each([MAX_QUOTE_FRAME_HEIGHT + 1, 10_000_000, Number.MAX_SAFE_INTEGER])(
    "clamps the runaway height %o down to the ceiling",
    (height) => {
      expect(
        resolveQuoteFrameHeight(message({ data: { type: "lms:quote-height", height } })),
      ).toBe(MAX_QUOTE_FRAME_HEIGHT)
    },
  )

  it("clamps a negative height up to the floor rather than collapsing the frame", () => {
    expect(
      resolveQuoteFrameHeight(message({ data: { type: "lms:quote-height", height: -5000 } })),
    ).toBe(MIN_QUOTE_FRAME_HEIGHT)
  })

  it("rounds fractional heights up so content is never clipped", () => {
    expect(
      resolveQuoteFrameHeight(
        message({ data: { type: "lms:quote-height", height: 1200.2 } }),
      ),
    ).toBe(1201)
  })
})

describe("resolveQuoteFrameDirty", () => {
  function dirty(over: Record<string, unknown> = {}) {
    return {
      origin: ORIGIN,
      source: FRAME,
      data: { type: "lms:quote-dirty", dirty: true },
      expectedOrigin: ORIGIN,
      expectedSource: FRAME,
      ...over,
    }
  }

  it("accepts a well-formed dirty report from the real frame", () => {
    expect(resolveQuoteFrameDirty(dirty())).toBe(true)
  })

  // Same discipline as the height guard: the sandbox permits popups, so a
  // window opened on the quote origin passes an origin-only check while not
  // being the frame.
  it("rejects a message from another window on the same origin", () => {
    expect(resolveQuoteFrameDirty(dirty({ source: { name: "a-popup" } }))).toBeNull()
  })

  it("rejects a message from a different origin", () => {
    expect(resolveQuoteFrameDirty(dirty({ origin: "https://evil.example" }))).toBeNull()
  })

  it("rejects everything while the frame is unmounted", () => {
    expect(resolveQuoteFrameDirty(dirty({ expectedSource: null }))).toBeNull()
  })

  it("ignores the height message", () => {
    expect(
      resolveQuoteFrameDirty(dirty({ data: { type: "lms:quote-height", height: 1200 } })),
    ).toBeNull()
  })

  // A frame that has been typed into cannot become untouched. Honouring
  // dirty:false would let a later message clear the flag and re-enable the
  // silent, destructive tab switch this exists to prevent.
  it("never reports not-dirty", () => {
    expect(resolveQuoteFrameDirty(dirty({ data: { type: "lms:quote-dirty", dirty: false } }))).toBeNull()
  })

  it("rejects junk payloads", () => {
    expect(resolveQuoteFrameDirty(dirty({ data: null }))).toBeNull()
    expect(resolveQuoteFrameDirty(dirty({ data: "dirty" }))).toBeNull()
  })
})
