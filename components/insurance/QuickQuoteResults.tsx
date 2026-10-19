"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  parsePremium,
  sortQuotes,
  summariseQuotes,
  tidyInsurerName,
  type ParsedQuote,
  type QuoteSort,
} from "@/lib/insurance/quickquote-bridge"
import { formatRands } from "@/lib/utils"

/**
 * Our results screen, rendered from the quotes FSP have already drawn.
 *
 * FSP hand back rendered HTML, not data — so we read their rows out of the DOM
 * and present our own list. This is the point of the product: a comparison
 * surface that does not let you sort, rank or benchmark has done the hard part
 * and skipped the reason anyone came.
 *
 * Every number shown is theirs. We parse, order and summarise; we never
 * compute a premium, and "I'm interested" clicks THEIR button so their lead
 * flow runs exactly as it would have.
 *
 * If parsing yields nothing — because their markup moved — this renders null
 * and the stylesheet reveals their own results untouched. Same failure posture
 * as the wizard: degrade to FSP's UI, never to a blank screen.
 */

type Props = {
  /** Their widget root. */
  host: HTMLElement | null
  /** Answers to summarise, already labelled for display. */
  summary: { label: string; value: string }[]
  onEdit: () => void
  /** Called once ≥1 quote has parsed. The parent hides FSP's own list only
      then, so a parse failure degrades to their UI rather than to nothing. */
  onParsed: (count: number) => void
  /**
   * FSP have confirmed the panel is finished.
   *
   * The LIST is safe to show as soon as arrivals settle — it self-corrects as
   * rows land. A SUPERLATIVE is not: "Best price" and the savings headline
   * name one row, and in staggered panels the late arrival is typically
   * the cheapest, so the tail is exactly what decides them. Withholding only
   * the claims makes a wrong one impossible rather than unlikely, instead of
   * betting the whole reveal on a timeout being longer than the worst gap.
   */
  panelComplete: boolean
}

/**
 * Reads FSP's rendered rows into our shape.
 *
 * Exported so the WAIT screen can show quotes arriving with the same parse the
 * results screen uses. A second copy of these selectors would drift, and the
 * two surfaces would then disagree about what a quote is mid-journey — the
 * failure class this repo has already paid for with duplicated validators.
 */
/**
 * Whether two parses describe the same rows.
 *
 * The MutationObserver fires on every change anywhere in FSP's subtree, and a
 * fresh extract allocates new objects each time, so without this the wait
 * screen re-renders on DOM churn that has nothing to do with quotes. Compares
 * what the arrival actually displays; a premium correcting in place is a real
 * change and must pass through.
 */
export function sameArrival(a: readonly ParsedQuote[], b: readonly ParsedQuote[]): boolean {
  if (a.length !== b.length) return false
  return a.every((q, i) => {
    const o = b[i]
    return (
      q.index === o.index &&
      q.insurer === o.insurer &&
      q.premiumLabel === o.premiumLabel &&
      q.logoUrl === o.logoUrl
    )
  })
}

export function extractQuotes(host: HTMLElement | null): ParsedQuote[] {
  if (!host) return []
  return [...host.querySelectorAll<HTMLElement>(".quotes .dataRow")]
    .map((row, index) => {
      const img = row.querySelector<HTMLImageElement>(".label img")
      const premiumLabel = (row.querySelector(".rightCol .premium")?.textContent ?? "").trim()
      const detail = (row.querySelector(".excess-details")?.textContent ?? "").trim()
      // Their detail line reads "Premium is R752.96 with basic excess"; the
      // excess wording is the part after "with".
      const excessLabel = detail.split(/\bwith\b/i).slice(1).join("with").trim()
      return {
        // Row position. Their OfferingId is not guaranteed unique across a
        // panel, and a duplicate makes find() return the wrong row — clicking
        // one insurer's card would send the lead for another's quote,
        // with two "Best price" badges on screen and, in a production bundle,
        // no duplicate-key warning to hint at it.
        index,
        // Their hidden OfferingId span. Everything keys off this, never the
        // displayed name.
        // Their OfferingId span, addressed by its knockout binding rather than
        // by position. ".excess-details span" also matches .quoted-premium and
        // .offering-excess, both nested in the anchor — so the fallback chain
        // never ran and the premium became the identity, which collides more
        // readily than the names it replaced.
        offeringId: (
          row.querySelector('.excess-details [data-bind*="OfferingId"]')?.textContent ?? ""
        ).trim(),
        // The logo filename is an opaque id, so the accessible name comes from
        // their own title attribute on the offering link.
        insurer: tidyInsurerName(
          row.querySelector(".excess-details a")?.getAttribute("title")?.trim() ||
            img?.getAttribute("alt")?.trim() ||
            "Insurer",
        ),
        logoUrl: img?.src ?? "",
        premium: parsePremium(premiumLabel),
        premiumLabel,
        excessLabel: excessLabel || "basic excess",
      }
    })
    .filter((q) => q.premiumLabel !== "")
}

export function QuickQuoteResults({
  host,
  summary,
  onEdit,
  onParsed,
  panelComplete,
}: Props) {
  const [quotes, setQuotes] = useState<ParsedQuote[]>([])
  const [order, setOrder] = useState<QuoteSort>("cheapest")
  const [actionError, setActionError] = useState<string | null>(null)
  const [reference, setReference] = useState("")
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const announced = useRef(false)

  useEffect(() => {
    if (!host) return
    const read = () => {
      setQuotes(extractQuotes(host))
      // Their reference lives inside .quotes, which we hide — anyone phoning
      // to follow up would otherwise have nothing to quote.
      const ref = (host.textContent ?? "").match(/reference number is\s*(\d+)/i)
      if (ref?.[1]) setReference(ref[1])
    }
    read()
    // They re-render rows when an offering is switched, so keep in step.
    const observer = new MutationObserver(read)
    observer.observe(host, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [host])

  /* This is the destination of the whole journey. Replacing the wait screen
     wholesale left focus on <body> and removed the only live region on the
     page, so a screen-reader user got no signal that quotes had arrived and a
     keyboard user had to explore from the top to discover them. */
  useEffect(() => {
    onParsed(quotes.length)
    if (quotes.length === 0 || announced.current) return
    announced.current = true
    headingRef.current?.focus()
  }, [quotes.length, onParsed])

  const ordered = useMemo(() => sortQuotes(quotes, order), [quotes, order])
  const stats = useMemo(() => summariseQuotes(quotes), [quotes])
  const cheapestIndex = useMemo(
    () => sortQuotes(quotes, "cheapest").find((q) => q.premium > 0)?.index,
    [quotes],
  )

  // Parsing found nothing — hand back to FSP's own rendering.
  if (quotes.length === 0) return null

  function interested(quote: ParsedQuote) {
    // Click THEIR button so their lead flow runs unchanged. Addressed by row
    // position, which is unique; ids and names are not.
    const rows = [...(host?.querySelectorAll<HTMLElement>(".quotes .dataRow") ?? [])]
    const row = rows[quote.index]
    const button = row?.querySelector<HTMLButtonElement>(".rightCol button")
    if (!button) {
      setActionError(
        "We couldn't open that quote — please refresh and try again.",
      )
      return
    }
    setActionError(null)
    button.click()
  }

  return (
    <section className="cf-res" aria-label="Your quotes">
      <p className="cf-visually-hidden" role="status" aria-live="polite">
        {quotes.length} {quotes.length === 1 ? "quote" : "quotes"} ready.
      </p>
      <header className="cf-res-head">
        <div>
          <p className="cf-res-eyebrow">Your quotes</p>
          <h2 className="cf-res-heading" tabIndex={-1} ref={headingRef}>
            {panelComplete && stats && stats.savingVsAverage >= 1 ? (
              <>
                Your best price is{" "}
                <strong>{formatRands(stats.savingVsAverage)} a month better</strong> than
                the average
              </>
            ) : (
              <>
                We found {quotes.length} {quotes.length === 1 ? "quote" : "quotes"} for you
              </>
            )}
          </h2>
          {/* The average is a BENCHMARK over the same unfinished field the
              superlative is withheld from — "average R2 095" is the claim the
              headline makes, in different words, and a late arrival moves both
              it and the priced count. Gating the badge and headline while
              printing this was withholding the sentence and keeping the
              assertion. Until the panel is confirmed finished, state only what
              is on screen. */}
          {/* `stats && panelComplete ? A : B` fell through to B whenever stats
              was null EVEN WITH the panel confirmed — so a panel FSP had told
              us was finished still read "still checking with the rest of the
              panel", indefinitely. The question is confirmation first, figures
              second. */}
          {panelComplete ? (
            stats ? (
            <p className="cf-res-sub">
              {stats.priced} {stats.priced === 1 ? "quote" : "quotes"} priced · average{" "}
              {formatRands(stats.average)} a month
              {stats.count > stats.priced && (
                <> · {stats.count - stats.priced} without a price</>
              )}
            </p>
            ) : null
          ) : (
            <p className="cf-res-sub">
              {quotes.length} {quotes.length === 1 ? "quote" : "quotes"} so far — still
              checking with the rest of the panel
            </p>
          )}
        </div>

        <label className="cf-res-sort">
          <span>Sort</span>
          <select value={order} onChange={(e) => setOrder(e.target.value as QuoteSort)}>
            {/* "Dearest" reads as a term of endearment before it reads as a
                price, and "dear" for expensive is archaic here. The sort
                VALUES stay as they are — they key sortQuotes() and its tests,
                and renaming them would buy the customer nothing. */}
            <option value="cheapest">Price: low to high</option>
            <option value="dearest">Price: high to low</option>
          </select>
        </label>
      </header>

      <ul className="cf-res-list">
        {ordered.map((q) => {
          const best = panelComplete && cheapestIndex === q.index && q.premium > 0
          return (
            <li key={q.index} className={best ? "is-best" : undefined}>
              {best && <p className="cf-res-badge">Best price</p>}
              <div className="cf-res-logo">
                {/* eslint-disable-next-line @next/next/no-img-element -- the
                    src is FSP's own CDN, resolved at runtime from their DOM;
                    next/image needs a configured remote host and cannot
                    optimise an origin we do not control. */}
                {q.logoUrl && <img src={q.logoUrl} alt="" />}
              </div>
              <div className="cf-res-detail">
                <p className="cf-res-insurer">{q.insurer}</p>
                <p className="cf-res-excess">{q.excessLabel}</p>
              </div>
              <div className="cf-res-price">
                <p className="cf-res-premium">
                  {q.premium > 0 ? formatRands(q.premium) : q.premiumLabel}
                  {/* The unit was never stated on FSP's own screen — this is
                      the number the whole journey exists to deliver. Omitted
                      when there is no number, so an unpriced row does not read
                      "Price on request per month". */}
                  {q.premium > 0 && <span> per month</span>}
                </p>
                <button type="button" onClick={() => interested(q)}>
                  I&apos;m interested
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {reference && (
        <p className="cf-res-ref">
          Quote reference <strong>{reference}</strong> — quote it if you call us.
        </p>
      )}

      {actionError && (
        <p className="cf-wiz-error" role="alert">
          {actionError}
        </p>
      )}

      <aside className="cf-res-summary">
        <div className="cf-res-summary-head">
          <h3>What we quoted on</h3>
          <button type="button" onClick={onEdit}>
            Change answers
          </button>
        </div>
        <dl>
          {summary.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </aside>

      {/* FSP's own disclosure lives in their `.quotes` block, which onParsed
          marks inert and the stylesheet collapses to 1px — so taking their
          screen over took their regulatory attribution off it with it.

          Both sentences are transcribed from THEIR results view on a live
          quote, not from their pre-quote page, which carries different
          wording ("The information provided on this QuickQuote Quotation
          Program is secure and is driven by…"). Provider disclosure is never
          paraphrased, summarised or merged.

          Two things are reproduced exactly as FSP writes them: "and is
          subject to verification" (their number agreement, not ours), and the
          #7889 reference. The ONLY edit is a space in "QuickQuote Quotation":
          their markup renders it as one word because two inline elements meet
          with no whitespace between them, which is a rendering artefact
          rather than their wording — their own pre-quote copy spaces it. */}
      <p className="cf-res-legal">
        This QuickQuote Quotation Program is driven by the systems of FSP Solutions, an
        authorised financial services provider #7889. The quotes provided from FSP
        Solutions are based on the information that you supplied and certain general
        assumptions and is subject to verification.
      </p>
    </section>
  )
}
