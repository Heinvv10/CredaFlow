import Link from "next/link"
import { Copy } from "lucide-react"

// Presentational only — takes a count and an href, never the leads themselves.
// That keeps the duplicate rows (names, phones, emails of OTHER people) out of
// the RSC payload of a page that only needs to say "there are some", and keeps
// this component free of any import that reaches prisma.

/**
 * "N possible duplicates" banner for the lead detail header.
 *
 * Renders nothing when the answer is a confident zero: an all-clear on every
 * one of the tenant's leads is noise that trains staff to ignore the banner on
 * the few that matter.
 *
 * `truncated` (the scan hit its cap) is NOT a confident zero, and is handled
 * separately for that reason. Silently rendering nothing on a capped scan would
 * make "we didn't finish looking" indistinguishable from "there are none" —
 * which is the exact undercount-reads-as-all-clear failure the count is
 * supposed to prevent.
 *
 * The copy says "possible" and links to a review, deliberately. Matching on a
 * shared phone or email is a heuristic — a couple sharing a phone, or a lead
 * re-enquiring after being converted, are both legitimate — so this points a
 * human at the evidence rather than asserting a verdict.
 */
export function LeadDuplicateFlag({
  count,
  href,
  truncated = false,
}: {
  count: number
  href: string
  /** The scan hit its cap, so `count` may be an undercount. */
  truncated?: boolean
}) {
  if (count < 1 && !truncated) return null

  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 flex items-start gap-3">
      <Copy className="h-4 w-4 flex-shrink-0 mt-0.5 text-orange-500" />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-orange-700">
          {count < 1
            ? "Duplicate check incomplete"
            : count === 1
              ? "1 possible duplicate"
              : `${count} possible duplicates`}
        </p>
        <p className="text-xs text-gray-600 mt-0.5">
          {count < 1 ? (
            // No "open the review to find out" CTA here: the review page runs
            // the SAME capped scan and would return the same zero. Promising
            // that a click resolves the uncertainty would be a lie.
            "There are too many leads to compare in one pass, so older leads were not checked against this one."
          ) : (
            // Whole sentences per branch rather than a ternary spliced into
            // surrounding JSX text. `{ternary} this lead's phone` renders as
            // "sharethis" in the production build: Turbopack (Next 16's default `next
            // build` bundler — its own Rust codepath, NOT the next-swc binding)
            // drops the leading whitespace of a text node that follows an
            // expression, emitting "Other leads share","this lead's phone…" as
            // two adjacent strings.
            //
            // Do NOT "verify" this with a render test. esbuild (vitest), tsc,
            // react-dom/server AND next-swc's own transformSync all KEEP that
            // space — they share a lineage that Turbopack's bundler does not, so
            // their agreement is one data point, not corroboration. Every such
            // probe passes against the broken source (one was written, watched
            // to pass on the bug, and thrown away). Only `npm run build` output
            // and the browser show the truth. Whole sentences need none of it.
            <>
              {count === 1
                ? "Another lead shares this lead's phone number or email address."
                : "Other leads share this lead's phone number or email address."}
              {truncated && " There may be more than shown."}
            </>
          )}{" "}
          {count >= 1 && (
            <Link
              href={href}
              className="font-medium text-orange-700 underline hover:text-orange-800"
            >
              Review {count === 1 ? "it" : "them"}
            </Link>
          )}
        </p>
      </div>
    </div>
  )
}
