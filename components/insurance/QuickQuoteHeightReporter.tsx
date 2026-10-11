"use client"

import { useEffect } from "react"
import { QUOTE_FRAME_HEIGHT_MESSAGE } from "@/lib/insurance/quickquote-frame-message"

/**
 * Reports this document's height to the embedding page.
 *
 * A cross-origin iframe cannot size itself, and QuickQuote's height changes a
 * lot as the visitor moves between the form and the returned quotes. Without
 * this the frame is a fixed box with its own scrollbar inside the page.
 *
 * The message carries a height and nothing else, so it is posted to "*" rather
 * than threading a parent origin through configuration. The check that matters
 * is on the receiving side: QuickQuotePanel ignores any message whose origin is
 * not the configured quote host.
 */
export function QuickQuoteHeightReporter() {
  useEffect(() => {
    if (window.parent === window) return

    /**
     * The CONTENT's height, measured so it can go DOWN as well as up.
     *
     * This used to report `document.documentElement.scrollHeight`, which is
     * never less than the viewport — and inside an iframe the viewport IS the
     * height the parent just set. That makes the sizing a one-way ratchet:
     *
     *   parent sets the frame to H -> the frame's viewport becomes H
     *   -> scrollHeight reports max(content, H) = H
     *   -> the parent sets H again, forever
     *
     * So a single tall transient — FSP's raw form flashing before the takeover
     * hides it — locked the frame at that height for the rest of the session.
     * Observed: a frame 2412px tall around 1221px of content, i.e.
     * ~1190px of dead space under the form. The boot skeleton makes the first
     * measurement taller, which only makes this more obvious.
     *
     * `body` is no better — something in the global stylesheet gives it a
     * full-height minimum, so it stretches to the viewport too. `main`'s bottom
     * edge in document coordinates does not: it reads 1221 at viewports of 700,
     * 1600 and 2000. That is what makes shrinking possible at all.
     */
    const contentHeight = () => {
      const main = document.querySelector("main")
      // No <main> means the page shape changed under us. Fall back to the old
      // reading rather than reporting nothing — a frame that is too tall is bad,
      // a frame stuck at MIN_QUOTE_FRAME_HEIGHT with the form cut off is worse.
      if (!main) return document.documentElement.scrollHeight
      return Math.ceil(main.getBoundingClientRect().bottom + window.scrollY)
    }

    const post = () => {
      window.parent.postMessage(
        { type: QUOTE_FRAME_HEIGHT_MESSAGE, height: contentHeight() },
        "*",
      )
    }

    post()

    // FSP's widget mutates the DOM well after load (knockout re-renders as
    // quotes arrive), so observing size alone is not enough — watch the tree.
    const resizeObserver = new ResizeObserver(post)
    resizeObserver.observe(document.documentElement)

    const mutationObserver = new MutationObserver(post)
    mutationObserver.observe(document.body, { childList: true, subtree: true })

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return null
}
