import { formatZAR } from "@/lib/utils"
import type { BoardPackChargesSummary } from "@/lib/reports/default-charges-loader"

/** Board-pack summary line for default charges; the detail is /reports/default-charges. */
export function BoardPackDefaultCharges({ summary }: { summary: BoardPackChargesSummary }) {
  const { exemptionRefunds } = summary
  return (
    <div className="bg-white rounded-2xl shadow-sm p-6 mb-6">
      <h2 className="text-lg font-bold text-[#1b1d24] mb-2">Default charges</h2>
      <p className="text-sm text-gray-700">
        This month: accrued {formatZAR(summary.accrued)}, collected {formatZAR(summary.collected)}.
      </p>
      <p className="mt-1 text-sm text-gray-700">
        Owing now: {formatZAR(summary.owingInBands)} on accounts in arrears (the bands above),{" "}
        {formatZAR(summary.owingNotInArrears)} on accounts with no instalment arrears
        {summary.owingElsewhere !== 0 && <>, and {formatZAR(summary.owingElsewhere)} on written-off and closed loans</>}.
      </p>
      {exemptionRefunds.count > 0 && (
        <p className="mt-1 text-sm text-gray-700">
          Charges to refund after exemptions: {formatZAR(exemptionRefunds.amount)} ({exemptionRefunds.count}).
        </p>
      )}
      <p className="mt-1 text-[11px] text-gray-500">
        Default interest and charges are shown beside instalment arrears and are not part of them. Collected is cash only.
      </p>
    </div>
  )
}
