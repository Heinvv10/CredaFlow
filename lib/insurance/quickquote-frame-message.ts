/**
 * Validation for the height messages the QuickQuote frame posts to its parent.
 *
 * Extracted from the component so the guard is testable without a DOM. This is
 * the only thing standing between "the trusted quote frame" and "any window
 * that can call postMessage on the marketing page", so it needs to be able to
 * fail a test when it regresses.
 */

/** Floor: the frame is never usefully shorter than this. */
export const MIN_QUOTE_FRAME_HEIGHT = 900

/**
 * Ceiling: a runaway or hostile value must not be able to stretch the page
 * into an unusable column.
 */
export const MAX_QUOTE_FRAME_HEIGHT = 6000

export const QUOTE_FRAME_HEIGHT_MESSAGE = "lms:quote-height"

/**
 * The frame telling its parent the visitor has entered something.
 *
 * FSP take `initialView` at init and expose no way to change quote type in
 * place, so switching the product tab necessarily re-initialises the frame and
 * discards whatever has been typed. The panel needs to know whether that costs
 * the visitor anything before it does it silently.
 */
export const QUOTE_FRAME_DIRTY_MESSAGE = "lms:quote-dirty"

export type QuoteFrameMessageInput = {
  /** `event.origin` */
  origin: string
  /** `event.source` */
  source: unknown
  /** `event.data` */
  data: unknown
  /** The origin the frame is expected to be served from. */
  expectedOrigin: string
  /** The frame's own `contentWindow`. */
  expectedSource: unknown
}

/**
 * Returns the clamped height to apply, or null if the message must be ignored.
 *
 * Both the origin AND the source window are checked. Origin alone is not
 * enough: the sandbox permits popups, and a window opened on the quote origin
 * would pass an origin-only check while not being the frame at all.
 */
export function resolveQuoteFrameHeight({
  origin,
  source,
  data,
  expectedOrigin,
  expectedSource,
}: QuoteFrameMessageInput): number | null {
  if (!expectedOrigin) return null
  if (origin !== expectedOrigin) return null

  // A null expectedSource means the frame is not mounted; nothing may claim to
  // be it. Without this an unmounted frame would make every source "match".
  if (!expectedSource) return null
  if (source !== expectedSource) return null

  if (typeof data !== "object" || data === null) return null
  const message = data as { type?: unknown; height?: unknown }
  if (message.type !== QUOTE_FRAME_HEIGHT_MESSAGE) return null
  if (typeof message.height !== "number") return null
  if (!Number.isFinite(message.height)) return null

  return Math.min(
    MAX_QUOTE_FRAME_HEIGHT,
    Math.max(MIN_QUOTE_FRAME_HEIGHT, Math.ceil(message.height)),
  )
}

/**
 * Whether the frame is reporting that the visitor has started answering.
 *
 * Returns null for anything that is not a well-formed dirty message from the
 * real frame — deliberately the SAME origin-and-source discipline as the height
 * guard above, and for the same reason: the sandbox permits popups, so a window
 * opened on the quote origin would pass an origin-only check while not being
 * the frame. Kept beside it so the two cannot drift apart.
 *
 * Only ever reports true. A frame that has been typed into cannot become
 * untouched, and accepting `dirty: false` would let a later message clear the
 * flag and re-enable a silent, destructive tab switch.
 */
export function resolveQuoteFrameDirty({
  origin,
  source,
  data,
  expectedOrigin,
  expectedSource,
}: QuoteFrameMessageInput): boolean | null {
  if (!expectedOrigin) return null
  if (origin !== expectedOrigin) return null
  if (!expectedSource) return null
  if (source !== expectedSource) return null

  if (typeof data !== "object" || data === null) return null
  const message = data as { type?: unknown; dirty?: unknown }
  if (message.type !== QUOTE_FRAME_DIRTY_MESSAGE) return null
  if (message.dirty !== true) return null

  return true
}
