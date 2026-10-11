/**
 * The scrim geometry, as data rather than a gradient string.
 *
 * ## Why this is not a percentage ellipse any more
 *
 * It was, and the ellipse was sized in percentages of the VIEWPORT while the
 * thing it had to protect — the reading column — is a fixed max-width. Those
 * two only agree at one width. Tuned at 1600px the copy held 5.67:1; at
 * 768px the same scrim let the FAIS quote-only disclosure fall to 3.04:1,
 * below the 4.5:1 AA floor, on 18 of 27 plate/viewport combinations. A
 * parameter search run at a single viewport could not have found that, and
 * did not.
 *
 * So the clear zone is defined in PIXELS, relative to the column:
 *
 *   |<- clear ->|<-------- solid over the column -------->|<- clear ->|
 *   0        margin                                    margin        W
 *
 * Below `2 * (HALF_COLUMN + FADE)` there is no margin at all, both clear
 * stops fall off-screen, and the whole viewport renders at SOLID. That is the
 * correct behaviour rather than a degenerate case: on a phone the page has no
 * dead space, so it should have no photograph.
 */

/**
 * Half the reading column, in REM — the same unit the column is declared in.
 *
 * `max-w-6xl` is 72rem, so its half is 36rem. This was 620 CSS PIXELS, and
 * that is the same defect as the percentage ellipse it replaced, one unit
 * down: px agrees with rem only at a 16px root. At Chrome's standard
 * Appearance > Font size > Large (20px root) the column becomes 1440px, its
 * text half-extent 704px, and the copy walks out of the protected band — the
 * FAIS quote-only disclosure measured 3.32:1 against a 4.5:1 floor, the same
 * magnitude as the failure this module was written to fix.
 *
 * In rem the band tracks the column at every root size, so the browser's own
 * accessibility setting cannot push text off the protection.
 *
 * 37, not 36. The column element's half is exactly 36rem, which sounds like
 * enough — but the gradient is centred on the VIEWPORT while the column is
 * centred on the content box, and a scrollbar offsets one from the other.
 * At a 16px root the disclosure began 6px inside the band with a plain 36.
 * That passes, and 6px is not a margin. The extra rem absorbs the widest
 * scrollbar at any root size; see COLUMN_PADDING_REM and the test that states
 * the requirement instead of leaving it to be re-measured by hand.
 */
export const HALF_COLUMN_REM = 37

/** Ramp from solid to clear, so the column's edge is not a visible seam. */
export const FADE_REM = 5

/** Root font size the px-facing helpers assume. Browsers may use another. */
export const ASSUMED_ROOT_PX = 16

/**
 * The column's own horizontal padding (`px-4`), inside its max-width.
 *
 * Text starts this far in from the column's edge, so it is what the band
 * actually has to cover — not the element's full half-width.
 */
export const COLUMN_PADDING_REM = 1

/**
 * Worst-case scrollbar, in px.
 *
 * The scrim is centred on the viewport; the column is centred on the content
 * box, which a classic scrollbar narrows. The two centres therefore differ by
 * up to half a scrollbar, and that difference eats directly into the margin.
 * 20px is generous for Windows classic (17px).
 */
export const SCROLLBAR_ALLOWANCE_PX = 20

/** Alpha over the reading column. The photograph must not lift text here. */
export const SOLID = 0.97

/** Alpha in the margins, where the photograph is the whole point. */
export const CLEAR = 0.06

/**
 * The widest viewport that is still FULLY scrimmed.
 *
 * Below this the column fills the screen, both fade stops are off-screen, and
 * no photograph shows at all — which is why the mobile AA failure this module
 * exists to fix cannot recur by tuning. Named for the property that is
 * actually asserted; the first correction to this file was that
 * `2 * (HALF_COLUMN + FADE)` is where the CLEAR stop reaches the edge, not
 * where the ramp begins, so at one pixel under it the edge was already at
 * 0.066 rather than solid.
 */
export const FULLY_SCRIMMED_BELOW = 2 * HALF_COLUMN_REM * ASSUMED_ROOT_PX

/**
 * The narrowest viewport at which the margins reach full CLEAR.
 *
 * Also the breakpoint the atmosphere is HIDDEN below. Between the column width
 * and this, CSS clamps a negative colour-stop to 0 and the emitted gradient
 * ramps clear-to-solid across the left edge only — a one-sided bright hairline
 * that `scrimAlphaAt` does not describe (measured 0.172 real vs 0.748 model at
 * 1280px). Not rendering the photograph at all below this removes the artefact
 * and the model/CSS divergence together, and it is what the design says
 * anyway: no dead space, no photograph.
 */
export const FULL_MARGINS_AT = 2 * (HALF_COLUMN_REM + FADE_REM) * ASSUMED_ROOT_PX

/**
 * Scrim alpha at horizontal position `x` for a viewport `width` wide.
 *
 * Pure, so the contrast floor can be asserted in a test instead of measured
 * by hand at one screen size and hoped for at the rest.
 */
export function scrimAlphaAt(x: number, width: number, rootPx = ASSUMED_ROOT_PX): number {
  const half = HALF_COLUMN_REM * rootPx
  const fade = FADE_REM * rootPx
  const from = Math.abs(x - width / 2)
  if (from <= half) return SOLID
  if (from >= half + fade) return CLEAR
  return SOLID + ((from - half) / fade) * (CLEAR - SOLID)
}

/** The horizontal layer, as a CSS gradient. Mirrors `scrimAlphaAt` exactly. */
export function horizontalScrim(): string {
  const c = (a: number) => `rgba(17,20,27,${a})`
  return [
    "linear-gradient(90deg",
    `${c(CLEAR)} 0`,
    `${c(CLEAR)} calc(50% - ${HALF_COLUMN_REM + FADE_REM}rem)`,
    `${c(SOLID)} calc(50% - ${HALF_COLUMN_REM}rem)`,
    `${c(SOLID)} calc(50% + ${HALF_COLUMN_REM}rem)`,
    `${c(CLEAR)} calc(50% + ${HALF_COLUMN_REM + FADE_REM}rem)`,
    `${c(CLEAR)} 100%)`,
  ].join(",")
}

/** Settles the top and bottom edges to the page colour. */
export function verticalScrim(): string {
  return [
    "linear-gradient(180deg",
    "rgba(17,20,27,0.80) 0%",
    "rgba(17,20,27,0.10) 22%",
    "rgba(17,20,27,0.10) 70%",
    "#11141b 100%)",
  ].join(",")
}
