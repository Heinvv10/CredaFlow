import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { formatZAR } from "@/lib/utils"

/**
 * "In arrears with us": the client is behind on a loan with this lender
 * (lib/affordability/own-lender-debt.ts ownLenderArrears). Shown wherever staff
 * start or assess a new application, so a new loan is not written blind to it.
 */
export function OwnLenderArrearsNotice({ arrears }: { arrears: { days: number; amountCents: number } | null }) {
  if (!arrears) return null
  return (
    <InfoStrip variant="danger">
      <span data-testid="own-lender-arrears">
        <strong>In arrears with us: {arrears.days} day{arrears.days === 1 ? "" : "s"}, {formatZAR(arrears.amountCents)}.</strong>{" "}
        Their loan instalments with us count in this affordability assessment.
      </span>
    </InfoStrip>
  )
}
