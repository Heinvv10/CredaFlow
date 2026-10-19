import { AlertTriangle } from "lucide-react"
import { formatZAR } from "@/lib/utils"

export interface OwnArrears {
  days: number
  amountCents: number
}

/**
 * "You are behind on a loan with us": shown on the portal qualify page, as the
 * staff assessment shows "In arrears with us" (components/applications/OwnLenderArrearsNotice.tsx).
 * English only: overdue-account text is never translated (lib/i18n/.claude.md).
 */
export function OwnArrearsNotice({ arrears }: { arrears: OwnArrears }) {
  return (
    <div
      data-testid="own-lender-arrears"
      className="flex items-start gap-3 rounded-lg p-4 mb-6 text-sm"
      style={{ backgroundColor: "var(--cf-surface-soft)", borderLeft: "3px solid #f59e0b", color: "var(--cf-text-secondary)" }}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
      <div>
        <p className="font-semibold text-[var(--cf-text)]">
          Your loan with us is {arrears.days} day{arrears.days === 1 ? "" : "s"} overdue ({formatZAR(arrears.amountCents)})
        </p>
        <p className="mt-1">
          Your instalments on your loans with us are included in your existing debt below. The figures are estimates, not an offer.
        </p>
      </div>
    </div>
  )
}
