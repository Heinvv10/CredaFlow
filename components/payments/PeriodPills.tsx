import Link from "next/link"
import { type Period, type PeriodKey } from "@/lib/date/sast-period"

/**
 * Period selector for the payments screen.
 *
 * Deliberately server-rendered links rather than client-side state. The row
 * lists are capped, so filtering in the browser would filter the most recent
 * 200 rows and present that as the whole period — and a link keeps the window
 * in the URL, where it can be shared, bookmarked and reached with the back
 * button. The pill row is the ONLY period control on the page: the three
 * hard-coded windows it replaced disagreed with the table beneath them.
 */

const PRESETS: Array<{ key: PeriodKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-year", label: "This year" },
  { key: "all", label: "All time" },
]

export function PeriodPills({ period }: { period: Period }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => {
        const selected = period.key === preset.key
        return (
          <Link
            key={preset.key}
            href={`/payments?period=${preset.key}`}
            aria-current={selected ? "page" : undefined}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              selected
                ? "border-[#4338CA] bg-[#4338CA] text-[var(--cf-on-brand,#fff)]"
                : "border-gray-200 text-gray-500 hover:border-[#4338CA] hover:text-[#4338CA]"
            }`}
          >
            {preset.label}
          </Link>
        )
      })}

      {/* A GET form, matching the Agent Hub date range. No JS, and the
          resulting URL is the same shape a pill produces. */}
      <form method="GET" action="/payments" className="flex items-center gap-1.5">
        <input type="hidden" name="period" value="custom" />
        <input
          type="date"
          name="from"
          required
          defaultValue={period.from ?? ""}
          aria-label="From date"
          className="rounded-lg border border-gray-200 bg-transparent px-2 py-1 text-xs text-gray-600"
        />
        <span className="text-xs text-gray-400">–</span>
        <input
          type="date"
          name="to"
          required
          defaultValue={period.to ?? ""}
          aria-label="To date"
          className="rounded-lg border border-gray-200 bg-transparent px-2 py-1 text-xs text-gray-600"
        />
        <button
          type="submit"
          className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            period.key === "custom"
              ? "border-[#4338CA] bg-[#4338CA] text-[var(--cf-on-brand,#fff)]"
              : "border-gray-200 text-gray-500 hover:border-[#4338CA] hover:text-[#4338CA]"
          }`}
        >
          Apply
        </button>
      </form>
    </div>
  )
}
