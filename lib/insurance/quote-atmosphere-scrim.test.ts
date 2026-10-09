import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ASSUMED_ROOT_PX,
  CLEAR,
  FADE_REM,
  HALF_COLUMN_REM,
  COLUMN_PADDING_REM,
  SCROLLBAR_ALLOWANCE_PX,
  FULLY_SCRIMMED_BELOW,
  FULL_MARGINS_AT,
  SOLID,
  horizontalScrim,
  scrimAlphaAt,
  verticalScrim,
} from "./quote-atmosphere-scrim"
import { ATMOS_STRENGTH } from "@/components/insurance/QuoteAtmosphere"

/** Page background, --cf-bg. */
const BG = [17, 20, 27] as const
/* Imported, not copied. A local literal duplicating it meant the component
   could be retuned and this floor would keep asserting the old number. */
const STRENGTH = ATMOS_STRENGTH

function channelLuminance(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: readonly number[]): number {
  return (
    0.2126 * channelLuminance(r!) +
    0.7152 * channelLuminance(g!) +
    0.0722 * channelLuminance(b!)
  )
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * The background a plate produces at `x`, given the scrim.
 *
 * `plate` defaults to PURE WHITE, which is what makes this bound hold for any
 * image. Every plate in the set peaks at 255 somewhere, so a floor proved
 * against white is a floor for all nine — and, more usefully, for whatever
 * replaces them. A test written against the current plates' measured content
 * would pass today and say nothing about tomorrow's.
 */
function backgroundAt(x: number, width: number, plate: readonly number[] = [255, 255, 255]) {
  const alpha = scrimAlphaAt(x, width)
  return BG.map((bg, i) => {
    const overPlate = plate[i]! * STRENGTH + bg * (1 - STRENGTH)
    return overPlate * (1 - alpha) + bg * alpha
  })
}

/** White text at `alpha` composited over `bg`. */
function textOver(bg: readonly number[], alpha: number) {
  return bg.map((c) => alpha * 255 + (1 - alpha) * c)
}

const VIEWPORTS = [320, 390, 414, 768, 834, 1024, 1280, 1440, 1600, 1920, 2560]

/**
 * The reading column's half-width, read from the SOURCE rather than assumed.
 *
 * QuoteSurface sets `max-w-6xl` (72rem). If that class ever changes, this
 * picks the new value up and the assertions below fail loudly instead of
 * silently protecting a column that is no longer there.
 */
const COLUMN_CLASS = readFileSync(
  join(process.cwd(), "components/insurance/QuoteSurface.tsx"),
  "utf8",
)
const TAILWIND_MAX_W_REM: Record<string, number> = {
  "max-w-4xl": 56,
  "max-w-5xl": 64,
  "max-w-6xl": 72,
  "max-w-7xl": 80,
}
const columnClass = Object.keys(TAILWIND_MAX_W_REM).find((c) => COLUMN_CLASS.includes(c))
const COLUMN_HALF_REM = (TAILWIND_MAX_W_REM[columnClass ?? ""] ?? 0) / 2
const COLUMN_HALF_PX = COLUMN_HALF_REM * ASSUMED_ROOT_PX

describe("quote atmosphere scrim", () => {
  /* Derived from the COLUMN, not from the constant under test. Sampling
     offsets that are <= HALF_COLUMN by construction cannot fail for any
     HALF_COLUMN at all — the previous version did exactly that, so widening
     the column to max-w-7xl would have moved the disclosure out of the solid
     band with zero test failures. */
  it("keeps the whole reading column under the solid band at every viewport", () => {
    for (const width of VIEWPORTS) {
      for (const offset of [0, 200, 400, COLUMN_HALF_PX]) {
        for (const x of [width / 2 - offset, width / 2 + offset]) {
          expect(scrimAlphaAt(x, width)).toBe(SOLID)
        }
      }
    }
  })

  /* The failure this file exists for. The scrim used to be a percentage
     ellipse, which agreed with the fixed-width column at exactly one viewport:
     tuned at 1600px the copy held 5.67:1, and at 768px the FAIS quote-only
     disclosure fell to 3.04:1 against a 4.5:1 AA floor — on 18 of 27
     plate/viewport combinations.

     Asserted against a PURE WHITE plate, so it is a statement about the scrim
     rather than about the nine images that happen to be in public/ today. */
  it.each(VIEWPORTS)("holds 12px text-white/60 above AA at %ipx wide", (width) => {
    for (let x = 0; x <= width; x += 8) {
      // Only the column carries text; the margins are the photograph's.
      if (Math.abs(x - width / 2) > HALF_COLUMN_REM * ASSUMED_ROOT_PX) continue
      const bg = backgroundAt(x, width)
      expect(contrast(textOver(bg, 0.6), bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(VIEWPORTS)("holds text-white/72 body copy above AA at %ipx wide", (width) => {
    for (let x = 0; x <= width; x += 8) {
      if (Math.abs(x - width / 2) > HALF_COLUMN_REM * ASSUMED_ROOT_PX) continue
      const bg = backgroundAt(x, width)
      expect(contrast(textOver(bg, 0.72), bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  /* A phone has no dead space beside the column, so it gets no photograph.
     This is what makes the mobile failure unreachable by tuning rather than
     merely tuned away. */
  it.each([320, 390, 414, 768, 1024, FULLY_SCRIMMED_BELOW])(
    "scrims the entire viewport at %ipx, where there is no margin",
    (width) => {
      for (let x = 0; x <= width; x += 8) {
        expect(scrimAlphaAt(x, width)).toBe(SOLID)
      }
    },
  )

  it("lets the photograph through in the margins on a wide viewport", () => {
    expect(scrimAlphaAt(20, 1920)).toBe(CLEAR)
    expect(scrimAlphaAt(1900, 1920)).toBe(CLEAR)
    const bg = backgroundAt(20, 1920)
    // Visibly lighter than the bare page, which is the entire point.
    expect(relativeLuminance(bg) / relativeLuminance(BG)).toBeGreaterThan(3)
  })

  it("only shows the photograph once the viewport exceeds the column", () => {
    expect(FULLY_SCRIMMED_BELOW).toBe(2 * HALF_COLUMN_REM * ASSUMED_ROOT_PX)
    expect(FULL_MARGINS_AT).toBe(2 * (HALF_COLUMN_REM + FADE_REM) * ASSUMED_ROOT_PX)
    expect(scrimAlphaAt(0, FULLY_SCRIMMED_BELOW + 2)).toBeGreaterThan(CLEAR)
  })

  /* The layer is HIDDEN below FULL_MARGINS_AT, and the Tailwind breakpoint has
     to be that same number. Between the column width and it, CSS clamps the
     negative colour-stop to 0 and renders a one-sided bright hairline that
     scrimAlphaAt does not describe — measured 0.172 real against 0.748 model
     at 1280px. Not rendering there removes the artefact and the model/CSS
     divergence together. A hand-typed class could drift from the constant, so
     it is asserted rather than trusted. */
  it("hides the layer below the width where margins exist", () => {
    const source = readFileSync(
      join(process.cwd(), "components/insurance/QuoteAtmosphere.tsx"),
      "utf8",
    )
    expect(source).toContain(`min-[${FULL_MARGINS_AT}px]:block`)
    expect(source).toMatch(/className="[^"]*\bhidden\b/)
  })

  /* PARSES the emitted gradient and checks its SHAPE.

     A substring-presence check is not a control: with one, swapping SOLID and
     CLEAR in the emitted CSS — photograph at 0.06 OVER the FAIS disclosure and
     0.97 in the margins, the exact inverse of the intent — left every test
     green, as did rotating 90deg to 0deg. Both fail here. */
  it("emits a gradient whose shape matches scrimAlphaAt", () => {
    const css = horizontalScrim()
    expect(css.startsWith("linear-gradient(90deg")).toBe(true)

    const stops = [
      ...css.matchAll(
        /rgba\(17,20,27,([\d.]+)\) (0|100%|calc\(50% ([-+]) ([\d.]+)rem\))/g,
      ),
    ].map((m) => ({
      alpha: Number(m[1]),
      at:
        m[2] === "0"
          ? 0
          : m[2] === "100%"
            ? 1920
            : 960 + (m[3] === "-" ? -1 : 1) * Number(m[4]) * ASSUMED_ROOT_PX,
    }))
    expect(stops).toHaveLength(6)
    expect(stops[0]!.alpha).toBe(CLEAR)
    expect(stops[2]!.alpha).toBe(SOLID)
    expect(stops[3]!.alpha).toBe(SOLID)
    expect(stops[5]!.alpha).toBe(CLEAR)
    // Solid over the middle, clear at the edges — not the inverse.
    expect(stops[2]!.alpha).toBeGreaterThan(stops[0]!.alpha)
    for (const stop of stops) {
      if (stop.at <= 0 || stop.at >= 1920) continue
      expect(scrimAlphaAt(stop.at, 1920)).toBeCloseTo(stop.alpha, 6)
    }
  })

  /* scrimAlphaAt does not model the vertical layer, so the white-plate bound
     only stays conservative while that layer can add darkness and never
     lightness. A white stop would put a lightening layer over the disclosure
     that the floor above cannot see. */
  it("keeps the vertical layer to the page colour only", () => {
    const colours = [...verticalScrim().matchAll(/rgba?\(([\d,\s.]+)\)|#([0-9a-fA-F]{6})/g)]
    expect(colours.length).toBeGreaterThan(0)
    for (const c of colours) {
      if (c[2]) {
        expect(c[2].toLowerCase()).toBe("11141b")
        continue
      }
      const [r, g, b] = c[1]!.split(",").map((n) => Number(n.trim()))
      expect([r, g, b]).toEqual([17, 20, 27])
    }
  })

  /* The scrim is sized in rem because the column is. A px constant agreed with
     it only at a 16px root: at Chrome's standard "Large" setting (20px) the
     column grew to 1440px and the FAIS disclosure measured 3.32:1. */
  it.each([16, 18, 20, 24])("keeps the column protected at a %ipx root", (rootPx) => {
    const width = 2560
    const columnHalf = COLUMN_HALF_REM * rootPx
    for (let x = width / 2 - columnHalf; x <= width / 2 + columnHalf; x += 8) {
      expect(scrimAlphaAt(x, width, rootPx)).toBe(SOLID)
    }
  })

  it("ramps rather than cutting a hard edge at the column boundary", () => {
    const mid = scrimAlphaAt(1920 / 2 + HALF_COLUMN_REM * ASSUMED_ROOT_PX + FADE_REM * ASSUMED_ROOT_PX / 2, 1920)
    expect(mid).toBeGreaterThan(CLEAR)
    expect(mid).toBeLessThan(SOLID)
  })

  it("finds the column class it is protecting", () => {
    expect(columnClass).toBeDefined()
    expect(COLUMN_HALF_REM).toBeGreaterThan(0)
  })

  /* The scrim must cover the column. This is the assertion that would have
     caught a max-w-6xl -> max-w-7xl change. */
  it("covers the reading column", () => {
    expect(HALF_COLUMN_REM).toBeGreaterThanOrEqual(COLUMN_HALF_REM)
  })

  /* And it must cover it with a REAL margin, which is a different claim.
     `>= COLUMN_HALF_REM` was satisfied by equality, and equality measured 6px
     of actual clearance on staging — because the gradient is centred on the
     viewport while the column is centred on the content box, so a scrollbar
     offsets one from the other and eats the difference. 6px is not a margin;
     it is a rounding error that happened to have the right sign.

     Stated here rather than re-measured by hand, at every root size a browser
     can be set to. */
  it.each([16, 18, 20, 24])(
    "clears the text by more than a scrollbar at a %ipx root",
    (rootPx) => {
      const bandHalfPx = HALF_COLUMN_REM * rootPx
      // Text starts inside the column's padding, and the column's centre can
      // sit half a scrollbar off the viewport's.
      const textEdgeFromViewportCentre =
        (COLUMN_HALF_REM - COLUMN_PADDING_REM) * rootPx + SCROLLBAR_ALLOWANCE_PX / 2
      expect(bandHalfPx - textEdgeFromViewportCentre).toBeGreaterThanOrEqual(
        SCROLLBAR_ALLOWANCE_PX,
      )
    },
  )
})
