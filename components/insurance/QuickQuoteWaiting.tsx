"use client"

import { useEffect, useRef, useState } from "react"
import { QuickQuoteArrival } from "@/components/insurance/QuickQuoteArrival"
import { waitingStage } from "@/lib/insurance/quickquote-bridge"
import type { ParsedQuote } from "@/lib/insurance/quickquote-bridge"

/**
 * The wait between submitting and quotes arriving.
 *
 * This is the highest-leverage screen in the journey. FSP allow themselves up
 * to 120 seconds (their own maxQuoteTime) and ship a bare spinner with "it
 * will be worth the wait"; observed runs return in about 10. Nielsen's
 * thresholds say anything past 10 seconds needs a percent-done indicator, and
 * the labour-illusion research (Buell & Norton, Management Science 2011) says
 * naming the work being done reduces the *perceived* wait even when the actual
 * wait is unchanged.
 *
 * HONESTY RULE: the progress here is derived from elapsed time against a real
 * observed distribution, and the quote count is read from FSP's own DOM as
 * rows appear. It never claims to be talking to a named insurer, because we
 * receive no per-insurer signal — inventing "Checking King Price…" against a
 * timer is the documented way progress bars lose their credibility. The copy
 * says what is true: we asked the panel, and we are waiting.
 */

type Props = {
  /** Rows FSP has rendered so far; drives the streaming count. */
  quoteCount: number
  /** True once we have waited long enough that something has gone wrong. */
  timedOut?: boolean
  /** Returns the visitor to their answers, which are preserved. */
  onRetry?: () => void
  /** Typical completion, from observed runs. Used to shape the curve only. */
  expectedMs?: number
  /**
   * Quotes parsed from FSP's rows so far, in arrival order.
   *
   * Same parse the results screen uses (extractQuotes), so the wait and the
   * results cannot disagree about what a quote is. Empty until the first row
   * lands, which is when the arrival list replaces the reassurance copy.
   */
  quotes?: readonly ParsedQuote[]
  /** FSP have confirmed the panel is finished. Gates the re-sort and the badge. */
  panelComplete?: boolean
}

// The stages and their selection live in lib/insurance/quickquote-bridge.ts.
// They are the one part of this screen that can state something false, and a
// node-environment suite cannot render a component to check it — so they sit
// behind a tested seam instead.

export function QuickQuoteWaiting({
  quoteCount,
  timedOut,
  onRetry,
  expectedMs = 12000,
  quotes = [],
  panelComplete = false,
}: Props) {
  const [elapsed, setElapsed] = useState(0)
  const start = useRef<number | null>(null)

  useEffect(() => {
    // Stamped inside the effect, not at render: reading the clock during
    // render makes the component impure and can drift under Strict Mode's
    // double invocation.
    start.current = Date.now()
    const id = window.setInterval(() => {
      if (start.current !== null) setElapsed(Date.now() - start.current)
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  // Accelerating toward completion, never reaching it: NN/g note that a bar
  // which decelerates near the end reads as broken. Asymptotic at 95% so we
  // never promise a finish we cannot guarantee.
  // Held at 85% until a real row lands. The curve knows nothing about the
  // request, so the last stretch has to be earned by evidence, not by time.
  const ceiling = quoteCount > 0 ? 0.97 : 0.85
  const progress = Math.min(ceiling, 1 - Math.exp(-elapsed / (expectedMs * 0.55)))

  /* "Usually 10 to 20 seconds", not 10. End to end, the first row lands
     around 9.6s, the last around 14.4s, results around 15.6s. Older
     copy stated a number the journey did not hit, and the "taking longer than
     usual" threshold fired at 20s — inside the normal range, so it called a
     healthy run abnormal. UI copy is a factual claim; both numbers now match
     what was observed. */
  const stage = waitingStage(elapsed, quoteCount)
  const seconds = Math.floor(elapsed / 1000)

  if (timedOut) {
    return (
      <div className="cf-wait" role="alert">
        <p className="cf-wait-eyebrow">Taking too long</p>
        <h2 className="cf-wait-heading">The insurers aren&apos;t responding</h2>
        <p className="cf-wait-meta">
          Your answers are still here — try again, or give us a call on{" "}
          <a href="tel:+27105000000">010 500 0000</a> and we&apos;ll do it with you.
        </p>
        {onRetry && (
          <button type="button" className="cf-wiz-next cf-wait-retry" onClick={onRetry}>
            Back to my answers
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="cf-wait">
      <p className="cf-wait-eyebrow">Getting your quotes</p>
      {/* Only the stage label and the quote count are announced. The
          progressbar recomputes every 200ms; inside a live region that would
          queue dozens of utterances across the wait. */}
      <h2 className="cf-wait-heading" role="status" aria-live="polite">
        {stage.label}
      </h2>

      <div
        className="cf-wait-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-label="Quote progress"
        aria-live="off"
      >
        <span className="cf-wait-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      <p className="cf-wait-meta" role="status" aria-live="polite">
        {quoteCount > 0 ? (
          <>
            <strong>{quoteCount}</strong> {quoteCount === 1 ? "quote" : "quotes"} in so far
          </>
        ) : (
          <>Usually 10 to 20 seconds{seconds > 30 ? " — this one is taking longer than usual" : ""}</>
        )}
      </p>

      {quotes.length > 0 ? (
        /* Once real rows exist the prices ARE the reassurance — showing them
           beats telling someone the panel is being asked. The copy below
           returns if a retry empties the list. */
        <QuickQuoteArrival quotes={quotes} panelComplete={panelComplete} />
      ) : (
        <ul className="cf-wait-reassure">
          <li>Your details go straight to FSP Solutions, who run the panel</li>
          <li>No obligation, and nothing is bought here</li>
        </ul>
      )}
    </div>
  )
}
