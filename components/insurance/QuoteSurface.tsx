"use client"

import { useState, type ReactNode } from "react"
import { QuickQuotePanel } from "@/components/insurance/QuickQuotePanel"
import { QuoteAtmosphere } from "@/components/insurance/QuoteAtmosphere"
import type { QuickQuoteView } from "@/lib/insurance/quickquote-config"

/**
 * The page's field, its copy and its panel, kept in step.
 *
 * ## What actually keeps the copy readable
 *
 * The atmosphere is `position: fixed`, and a positioned element paints ABOVE
 * non-positioned content REGARDLESS of document order. Rendered inside `<main>`
 * it covered the heading and, worse, reduced the FAIS quote-only disclosure to
 * a grey smear. A disclosure that cannot be read is not a disclosure, so this
 * is a correctness constraint and not a matter of taste.
 *
 * **`relative z-10` on <main> below is the whole of the protection.** An
 * earlier version of this comment claimed sibling order made the problem
 * unrepresentable. That is wrong — painting order between a positioned and a
 * non-positioned element ignores document order entirely — and the claim was
 * disproved twice: deleting only the `z-10` puts the photograph straight back
 * over the disclosure, and the same oversight had already erased the site
 * footer, which is a non-positioned sibling further up the tree. Do not remove
 * that class, and do not trust ordering to save you.
 *
 * `Footer` carries its own `relative z-10` for the same reason. A negative
 * z-index on the layer is NOT an alternative: the website layout wrapper paints
 * a background (`bg-[#11141b]`), and a negative-z descendant would paint behind
 * it and disappear.
 *
 * ## Why the view is mirrored, not owned
 *
 * The panel keeps its own view state and its own tab-switch guard — the
 * "switching starts a new quote and clears what you have entered" confirmation,
 * which exists because switching once destroyed people's answers silently.
 * Making it controlled would move that guard out to a caller with no business
 * owning it. Instead the panel reports the view it has SETTLED on, so backing
 * out of the confirmation correctly leaves the field where it was.
 */
export function QuoteSurface({
  origin,
  views,
  plates,
  initialView,
  children,
  footnote,
}: {
  origin: string
  views: readonly QuickQuoteView[]
  plates: Partial<Record<QuickQuoteView, string>>
  /**
   * The tab to open on, resolved on the server from the URL.
   *
   * Passed down rather than read here so the FIRST paint is already the right
   * product — reading it client-side would render the car tab and then swap,
   * which is the flicker this replaces, not a fix for it. It also decides the
   * plate: the field behind the surface has to match the tab from the start.
   */
  initialView?: QuickQuoteView
  /** Copy that belongs ABOVE the panel — breadcrumb, heading, disclosure. */
  children: ReactNode
  /**
   * Copy that belongs BELOW the panel.
   *
   * A separate slot rather than more children, because the FSP small print
   * ends "see the important information on the form" — it points AT the panel,
   * so it has to follow it. Folding everything into one slot silently moved
   * that sentence above the thing it refers to.
   *
   * REQUIRED, not optional. What goes here carries the FSP licence number, and
   * an optional slot lets a second caller drop regulatory copy by simply not
   * knowing about it. Required makes every call site state what it is passing.
   */
  footnote: ReactNode
}) {
  const [view, setView] = useState<QuickQuoteView>(initialView ?? views[0] ?? "motor")

  return (
    <>
      <QuoteAtmosphere plates={plates} view={view} />
      <main className="relative z-10 mx-auto max-w-6xl px-4 py-12 sm:py-16">
        {children}
        <div className="mt-8">
          <QuickQuotePanel
            origin={origin}
            views={views}
            plates={plates}
            initialView={initialView}
            onViewChange={setView}
          />
        </div>
        {footnote}
      </main>
    </>
  )
}
