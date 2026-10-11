"use client"

import { useEffect, useRef, useState } from "react"
import {
  buildQuoteFrameSrc,
  QUICKQUOTE_VIEWS,
  type QuickQuoteView,
} from "@/lib/insurance/quickquote-config"
import {
  MIN_QUOTE_FRAME_HEIGHT,
  resolveQuoteFrameDirty,
  resolveQuoteFrameHeight,
} from "@/lib/insurance/quickquote-frame-message"

/**
 * The marketing-side entry point to QuickQuote.
 *
 * Renders an iframe pointed at the isolated quote host. Nothing of FSP's — not
 * their jQuery 1.9.1 bundle, not their JSONP, not the Google Analytics property
 * their script injects — loads into this origin.
 *
 * The frame mounts immediately on page load (a deliberate product decision,
 * overriding a click-to-load gate): FSP's analytics
 * cookies are now set on every passive view of this section, not just after
 * an explicit "Get instant quotes" click. Do not revert this silently if a
 * consent requirement resurfaces — see the note below.
 *
 * NOTE ON CONSENT: this panel captures none, deliberately. An earlier revision
 * put a consent checkbox here and wrote an audit row before mounting the
 * frame; it was removed because the gate was on the wrong origin — the quote
 * host renders the widget on its own, so typing its URL bypassed the checkbox
 * entirely and the record went unwritten. Whatever replaces it belongs on the
 * origin that actually collects the information, and its content depends on
 * whether the FSP contract makes them an operator or an independent
 * responsible party. Do not re-add a consent step here.
 */

// Labels follow FSP's own view semantics, verified against the markup their
// endpoint returns: `home` binds quoteTypes.homecontent ("Home Contents") and
// `building` binds quoteTypes.buildings ("Buildings"). Do not swap these — the
// two are different products and the tab is what picks the quote the visitor
// gets. Note this taxonomy is FSP's, not the one InsuranceEnquiryForm uses.
const VIEW_LABELS: Record<QuickQuoteView, string> = {
  motor: "Vehicle",
  home: "Home contents",
  building: "Buildings",
}

export function QuickQuotePanel({
  origin,
  views = QUICKQUOTE_VIEWS,
  initialView,
  plates,
  onViewChange,
}: {
  origin: string
  /**
   * The plate the page is showing behind this panel, per view.
   *
   * Forwarded to the frame so the form's own backdrop is the SAME photograph
   * as the margins around it rather than a second, unrelated one. The frame is
   * a different origin and its body is opaque, so it cannot inherit the field
   * by transparency — the only way it can agree is to be told.
   *
   * Optional because the panel is also embedded by callers that have no field
   * behind them; the frame falls back to its view's first plate.
   */
  plates?: Partial<Record<QuickQuoteView, string>>
  /**
   * Which product tabs to offer. Pass a single view to drop the tab strip
   * entirely — the quotes page passes just `motor` while
   * FSP_QUICKQUOTE_MULTI_RISK is off, and all three once it is on. All three
   * are real wizard journeys; none falls through to FSP's own unstyled form.
   */
  views?: readonly QuickQuoteView[]
  /**
   * The tab to open on, resolved on the server from the URL.
   *
   * Without it the panel always started on the first offered view, so a reload
   * dropped someone pricing their house back onto the car form.
   */
  initialView?: QuickQuoteView
  /**
   * Called when the panel COMMITS a product switch — after the
   * clears-your-answers confirmation, never before it. A caller mirroring this
   * (the page's photographic field does) therefore stays put when someone opens
   * the confirmation and backs out, which is the correct reading of what
   * happened: nothing switched.
   */
  onViewChange?: (view: QuickQuoteView) => void
}) {
  const [view, setView] = useState<QuickQuoteView>(initialView ?? views[0] ?? "motor")
  const plate = plates?.[view]

  /* The one place a view change lands. Both routes to a switch — the tab click
     when nothing has been entered, and the confirmation when something has —
     go through here, so a caller cannot be told about one and not the other.
     That is also why the URL is written here: a second write site would be one
     more thing to keep in step with the guard. */
  const commitView = (next: QuickQuoteView) => {
    setView(next)
    onViewChange?.(next)

    /* REPLACE, not push. A tab click is not a place someone navigated to, and
       pushing would put Back between tabs — where it would switch the product
       without going through the confirmation that guards half-typed answers,
       which is the one route around that guard. Replacing also keeps Back
       meaning "the page I came from" after three idle tab clicks.

       history directly rather than router.replace: this only has to make the
       address bar survive a refresh, and a Next navigation would re-render the
       server component and remount the frame — discarding the answers the
       guard exists to protect.

       NULL state, not window.history.state, and the difference is not cosmetic.
       The App Router patches replaceState so that raw history calls still reach
       its own URL bookkeeping, and that patch opens with a loop-guard:
       `if (data?.__NA || data?._N) return originalReplaceState(...)`. Next
       stamps __NA onto every entry it manages, so handing window.history.state
       straight back looks to the patch like a call from Next's own internals —
       it takes the early return and skips the sync. Passing null loses nothing,
       because copyNextJsInternalHistoryState re-attaches __NA and the internals
       tree from the CURRENT state regardless; it only changes which branch the
       guard takes. Verified against next@16.2.12,
       dist/client/components/app-router.js:271 and :84. */
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("view", next)
      window.history.replaceState(null, "", url)
    }
  }
  const [height, setHeight] = useState(MIN_QUOTE_FRAME_HEIGHT)
  /* The frame has reported that the visitor has typed something into it. */
  const [dirty, setDirty] = useState(false)
  /* Which tab the visitor asked for while their answers were still in the
     frame. Holding it here rather than switching immediately is the whole
     point: FSP cannot change quote type in place, so the switch is
     destructive and has to be asked about first. */
  const [pendingView, setPendingView] = useState<QuickQuoteView | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // The quote host reports its rendered height so the frame grows with the
  // form instead of trapping it behind an inner scrollbar. Validation lives in
  // resolveQuoteFrameHeight so it is testable without a DOM — see its tests.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        resolveQuoteFrameDirty({
          origin: event.origin,
          source: event.source,
          data: event.data,
          expectedOrigin: origin,
          expectedSource: frameRef.current?.contentWindow ?? null,
        })
      ) {
        setDirty(true)
        return
      }

      const next = resolveQuoteFrameHeight({
        origin: event.origin,
        source: event.source,
        data: event.data,
        expectedOrigin: origin,
        expectedSource: frameRef.current?.contentWindow ?? null,
      })
      if (next === null) return
      setHeight(next)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [origin])

  return (
    <div className="border border-white/12 bg-black/20">
      {/* One view means there is no choice to present, and a lone highlighted
          tab reads as a disabled control rather than a label. */}
      {views.length > 1 && (
      <div className="border-b border-white/12 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {views.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                if (option === view) return
                // Nothing entered yet: switching costs nothing, so do not
                // interrupt someone who is still choosing a product.
                if (!dirty) {
                  commitView(option)
                  return
                }
                setPendingView(option)
              }}
              aria-pressed={view === option}
              className={
                view === option
                  ? "border border-[#a5b4fc] bg-[#a5b4fc]/15 px-4 py-2 text-sm font-semibold text-white"
                  : "border border-white/12 px-4 py-2 text-sm text-white/72 hover:border-white/28 hover:text-white"
              }
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>

        {/* Inline, never window.confirm(): a native modal blocks the whole
            page including the frame beneath it, and this repo's browser
            guidance forbids them outright. Rendered inside the tab strip so
            the question appears where the click happened. */}
        {pendingView && (
          <div
            role="alertdialog"
            aria-label="Switch quote type"
            className="mt-4 border border-[#a5b4fc]/45 bg-[#a5b4fc]/10 px-4 py-3"
          >
            <p className="text-sm text-white/88">
              Switching to <strong className="font-semibold">{VIEW_LABELS[pendingView]}</strong>{" "}
              starts a new quote and clears what you have entered.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  // The new frame is untouched, so the warning must not
                  // survive the switch that consumed it.
                  setDirty(false)
                  commitView(pendingView)
                  setPendingView(null)
                }}
                className="bg-[#a5b4fc] px-4 py-2 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
              >
                Switch and start over
              </button>
              <button
                type="button"
                onClick={() => setPendingView(null)}
                className="border border-white/26 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Keep my answers
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      <iframe
        ref={frameRef}
        title="Compare insurance quotes"
        // The plate rides in the URL rather than a postMessage because the
        // frame needs it in its FIRST render — a message arrives after the
        // frame has already painted, which would show one backdrop and then
        // swap it. The frame validates the value against its own view's plates
        // and ignores anything else, so this is a hint, never a source.
        src={buildQuoteFrameSrc(origin, view, plate)}
        // Already a separate origin; the sandbox adds the restrictions that
        // origin alone does not give. Each token is deliberate:
        //   allow-scripts      — FSP's widget is entirely script-driven
        //   allow-same-origin  — without it the frame gets an opaque origin
        //                        and FSP's own JSONP requests fail
        //   allow-forms        — the quote flow submits form controls
        //   allow-popups       — insurer policy-wording links open outward
        // Notably ABSENT: allow-top-navigation, so a script inside the frame
        // cannot redirect the page around it. allow-modals is also absent and
        // is not needed — FSP's bundle contains zero native alert/confirm/
        // prompt calls; its two dialogs are jQuery UI .dialog() widgets,
        // which are in-page DOM and unaffected by the sandbox.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        /* Native deferral, not a click and not an IntersectionObserver.
           Dropping the gate means FSP's jQuery 1.9.1 bundle would otherwise
           load for every visitor to this page — and the section sits ~2,700px
           down, so most of them never reach it. `loading="lazy"` gives the
           visitor the same zero-click experience (it is already there when
           they scroll to it) while not fetching a third-party bundle, or
           letting FSP set cookies, for someone who bounces off the hero.
           Browsers without support simply load eagerly, which is the old
           behaviour of this branch — so the fallback is safe. */
        loading="lazy"
        /* ⚠️ DO NOT ADD A CSS TRANSITION ON HEIGHT HERE. It makes the frame
           OSCILLATE forever, which is far worse than the snap it was meant to
           soften.
           The loop: animating the height continuously changes the FRAME's
           viewport; the frame's ResizeObserver watches document.documentElement
           and fires on every intermediate value; scrollHeight is never less
           than the viewport, so the frame reports the animating height straight
           back; the parent applies it and re-animates. Observed:
           1224 <-> 2037 on a ~1s cycle, indefinitely; without the transition
           there are no further height messages.
           Smoothness comes from the boot skeleton inside the frame reserving
           the form's real height instead (QuickQuoteBootSkeleton), which leaves
           only a ~2px change to absorb. There is nothing left worth animating. */
        className="w-full border-0"
        style={{ height }}
      />
    </div>
  )
}
