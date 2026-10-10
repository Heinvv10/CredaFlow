"use client"

import Image from "next/image"
import { arrivalPlan, formatRands, type ParsedQuote } from "@/lib/insurance/quickquote-bridge"

/**
 * Quotes landing, one insurer at a time, then re-sorting into price order.
 *
 * The wait used to be three lines of text for ten seconds. This replaces the
 * dead air with the only thing on the screen the visitor actually wants: the
 * prices, arriving. FSP hand rows over in their own order — observed as
 * King Price, Absa, Auto and General, Virseker, 1st For Women,
 * which is not price order — so once the panel is complete the whole set
 * reorders and the cheapest rises to the top.
 *
 * WHY THE RE-SORT IS THE POINT: it performs the comparison on the visitor's
 * behalf, visibly. A list that simply appeared already-sorted would be a
 * weaker claim, because nothing showed the work.
 *
 * HONESTY, inherited from QuickQuoteWaiting's rule and unchanged here:
 *   - a row cannot appear before FSP have actually returned it; every row on
 *     screen is a real response, never a timer firing against a name;
 *   - nothing is badged best until the panel is complete. arrivalPlan owns
 *     that rule and is mutation-tested on it, because a "Best price" badge is
 *     a claim about the whole panel and the late arrival has repeatedly been
 *     the cheapest one.
 *
 * Positions come from arrivalPlan rather than from array order, so this
 * component only ever animates between two numbers it is handed. The ordering
 * decision stays in the tested seam where it can be falsified — a node-env
 * suite cannot render this file.
 */

type Props = {
  /** Quotes parsed from FSP's rows so far, in the order they arrived. */
  quotes: readonly ParsedQuote[]
  /** FSP have confirmed the panel is finished. Gates the re-sort and the badge. */
  panelComplete: boolean
}

/**
 * Row pitch in rem — the SINGLE source of truth.
 *
 * Published to CSS as --cf-arrival-pitch on the list below, so the stylesheet
 * derives row height from this constant rather than restating it. Previously
 * both sides held their own 3.25 and the CSS token sat next to
 * --cf-atmos-opacity, which is explicitly advertised as safe to retune — so
 * the obvious edit would have changed row height while positioning stayed put,
 * and the rows would have overlapped.
 */
const PITCH_REM = 3.25

export function QuickQuoteArrival({ quotes, panelComplete }: Props) {
  const plan = arrivalPlan(quotes, panelComplete)
  if (plan.length === 0) return null

  return (
    <ol
      className="cf-arrival"
      style={
        {
          height: `${plan.length * PITCH_REM}rem`,
          "--cf-arrival-pitch": `${PITCH_REM}rem`,
        } as React.CSSProperties
      }
      // The list reorders under the reader; announcing every move would be
      // noise. QuickQuoteWaiting already announces the count politely, and the
      // results screen announces the final ordering when it takes over.
      aria-live="off"
    >
      {plan.map((slot) => (
        <li
          key={slot.quote.index}
          className={`cf-arrival-row${slot.isBest ? " is-best" : ""}`}
          style={{ transform: `translateY(${slot.settlesAt * PITCH_REM}rem)` }}
        >
          <span className="cf-arrival-logo">
            {slot.quote.logoUrl ? (
              // Decorative: the insurer is named in text beside it, so a
              // duplicate accessible name would just be read twice.
              // Scraped from the insurer panel's own markup (arbitrary remote
              // host, intrinsic size unknown), so it cannot go through the
              // optimizer; CSS caps the rendered size.
              <Image
                src={slot.quote.logoUrl}
                alt=""
                width={56}
                height={24}
                unoptimized
                style={{ width: "auto", height: "auto" }}
              />
            ) : null}
          </span>
          <span className="cf-arrival-name">{slot.quote.insurer}</span>
          {slot.isBest && <span className="cf-arrival-badge">Best price</span>}
          <span className="cf-arrival-premium">
            {slot.quote.premium > 0 ? formatRands(slot.quote.premium, 2) : slot.quote.premiumLabel}
          </span>
        </li>
      ))}
    </ol>
  )
}
