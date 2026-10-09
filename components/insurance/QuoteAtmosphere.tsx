"use client"

import Image from "next/image"
import type { QuickQuoteView } from "@/lib/insurance/quickquote-config"
import { horizontalScrim, verticalScrim } from "@/lib/insurance/quote-atmosphere-scrim"

/**
 * How present the photograph is at its most visible, in the periphery.
 *
 * ONE token, on the same principle as --cf-atmos-opacity inside the frame:
 * the strength of a photographic wash is a judgement that has to be made on the
 * real page at a real width, so tuning it must be a one-line change and never a
 * hunt through gradient stops. Started at 0.42, which measured as a vignette
 * rather than a photograph once the layering was fixed.
 */
export const ATMOS_STRENGTH = 0.52

/**
 * The photographic field behind the quote page.
 *
 * ## The photograph lives only in the margins beside the reading column
 *
 * The page's actual defect was emptiness: a ~1117px column of form floating in a
 * much wider dark viewport with several hundred pixels of dead margin either
 * side. So the photograph is strongest exactly where that emptiness is — the
 * periphery — and is scrimmed almost to nothing behind the centre column, where
 * the heading, the FAIS disclosure and the form live. Text never sits on a busy
 * image, and the space that read as unfinished now carries the atmosphere.
 *
 * A flat overlay would have done the opposite: evenly muddy everywhere, loudest
 * behind the words.
 *
 * ## One moment, not scattered effects
 *
 * All plates are rendered stacked and only the active one is opaque, so
 * switching product cross-dissolves the whole field. That is the single
 * deliberate animation on this surface — it says "this is about your home now"
 * at the exact moment the visitor says it. Everything else stays still.
 *
 * Stacking also means the dissolve never waits on a network fetch; a tab switch
 * that had to load an image first would flash the bare background.
 */
export function QuoteAtmosphere({
  plates,
  view,
}: {
  /** One plate per offered view, chosen server-side for this load. */
  plates: Partial<Record<QuickQuoteView, string>>
  view: QuickQuoteView
}) {
  const entries = Object.entries(plates) as [QuickQuoteView, string][]
  if (entries.length === 0) return null

  return (
    <div
      // Fixed, so the field stays put while the form scrolls over it — the
      // photograph is the room, not part of the document.
      /* Hidden below the width at which margins exist at all. Two reasons,
         and both are correctness rather than taste: CSS clamps the negative
         colour-stop to 0 between the column width and this breakpoint, which
         renders a one-sided bright hairline the scrim model does not describe;
         and a viewport with no dead space should not carry a photograph.
         1344 is FULL_MARGINS_AT; a test asserts the two agree, because a
         hand-typed breakpoint is exactly the kind of thing that drifts. */
      className="pointer-events-none fixed inset-0 z-0 hidden overflow-hidden min-[1344px]:block"
      aria-hidden="true"
    >
      {entries.map(([plateView, src]) => (
        <Image
          key={plateView}
          src={src}
          alt=""
          fill
          // Decorative and behind everything, so it must never compete with the
          // form for bandwidth on first paint.
          priority={false}
          sizes="100vw"
          // 75, and it must be passed explicitly: next.config.ts allow-lists
          // [55, 75] and Next coerces anything else to the nearest allowed
          // value.
          //
          // This was 55, on the reasoning that these sit "under a 6-97% scrim
          // at 52% opacity; nobody will ever see the difference". That holds
          // for the band the scrim covers and is false for the only band anyone
          // looks at: the margins render at CLEAR, which is 0.06 — all but
          // unscrimmed. Measured against the source on the visible left strip,
          // q=55 keeps 80.5% of its edge detail and q=75 keeps 88.7%, so the
          // softness was real and roughly half of it was ours.
          quality={75}
          className="object-cover transition-opacity duration-700 ease-out motion-reduce:transition-none"
          style={{ opacity: plateView === view ? ATMOS_STRENGTH : 0 }}
        />
      ))}

      {/* The photograph is allowed EXACTLY in the margins beside the reading
          column, and nowhere else.

          Both layers are built only from --cf-bg's own colour, so the field
          adds luminance and texture and no new hue — a photograph with its own
          cast would fight the gold, which is this brand's single accent.

          The horizontal layer is keyed to the column in REM — the same unit
          the column is declared in. See quote-atmosphere-scrim.ts for the two
          failures that produced that: a percentage ellipse agreed with the
          column at one viewport (disclosure 3.04:1 below 1280px), and the px
          constant that replaced it agreed only at a 16px root (3.32:1 at
          Chrome's standard "Large" font setting). Rem is the unit at which
          "only in the dead space" is true for every width AND every root. */}
      <div
        className="absolute inset-0"
        style={{ background: [horizontalScrim(), verticalScrim()].join(",") }}
      />
    </div>
  )
}
