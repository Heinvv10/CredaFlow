/**
 * The photographic field behind the quote surface.
 *
 * ## Why detail crops rather than product shots
 *
 * A comparison page covered in cars-on-mountain-roads reads as a lead-generation
 * farm, which is the opposite of what this one is. Every plate here is a DETAIL
 * — the wet door line under a streetlight, late sun raking a plaster wall, the
 * corner of a face-brick reveal — shot in bright warm light so that under the
 * scrim they read as depth rather than as a flat slab. They were
 * generated in one house style; a stock library would break that consistency,
 * and consistency is most of what makes the surface look considered.
 *
 * ## Why the choice is made on the server
 *
 * The plate is picked per REQUEST and then held for the whole page load. Picking
 * client-side would either mismatch on hydration or change under a visitor
 * mid-journey — and an image that swaps while someone is on step 3 of an
 * insurance application is a distraction, not a delight. Rotating between loads
 * gives the variety without ever moving under the reader.
 */

import { QUICKQUOTE_VIEWS, type QuickQuoteView } from "./quickquote-config"

/**
 * The plates per product, all decorative. EMPTY: the photographs that used to
 * live here belonged to the lender this codebase was forked from, and no image
 * is requested until a tenant supplies its own. Every consumer treats a view
 * with no plate as "no photographic layer" (QuoteAtmosphere renders nothing,
 * the frame URL omits `plate`).
 *
 * Ordered but not ranked — `pickPlates` treats them as interchangeable, so any
 * one of them has to be able to carry the page on its own.
 */
export const ATMOS_PLATES: Record<QuickQuoteView, readonly string[]> = {
  motor: [],
  home: [],
  building: [],
}

/**
 * One plate per view, chosen for this page load.
 *
 * Returns a plate for EVERY view that has one, not only the active one, because the surface
 * renders all of them stacked and cross-dissolves between them — a tab switch
 * that had to fetch an image first would flash the bare background at exactly
 * the moment it is meant to feel deliberate.
 *
 * `random` is a parameter so the choice is testable. A function that reached for
 * `Math.random()` internally could only be asserted against itself.
 */
export function pickPlates(
  random: () => number = Math.random,
): Partial<Record<QuickQuoteView, string>> {
  const chosen: Partial<Record<QuickQuoteView, string>> = {}
  for (const view of QUICKQUOTE_VIEWS) {
    const plates = ATMOS_PLATES[view]
    if (plates.length === 0) continue
    // Clamped rather than trusted: a random source returning exactly 1, or
    // anything outside [0,1), would index past the end and put `undefined` into
    // an <img src>, which renders as a broken-image icon over the whole page.
    //
    // The finite check is NOT redundant with the clamp — Math.min and Math.max
    // both PROPAGATE NaN rather than rejecting it, so a NaN source sailed
    // through the clamp and produced exactly the undefined it exists to
    // prevent. Found by the test, not by reading it.
    const raw = Math.floor(random() * plates.length)
    const index = Number.isFinite(raw)
      ? Math.min(plates.length - 1, Math.max(0, raw))
      : 0
    chosen[view] = plates[index]!
  }
  return chosen
}
