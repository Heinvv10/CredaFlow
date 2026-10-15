import { formatIsoDate } from "@/lib/asset-finance/format"
import type { WithdrawnRecovery } from "./recovery-panel-data"
import { ROUTE_LABELS } from "./recovery-model"

/** Earlier recoveries of the loan that were withdrawn, one compact line each (a withdrawn recovery never blocks a new one). */
export function WithdrawnHistory({ withdrawn }: { withdrawn: WithdrawnRecovery[] }) {
  if (withdrawn.length === 0) return null
  return (
    <ul className="space-y-1 text-sm text-[var(--cf-text-muted)]">
      {withdrawn.map((r) => (
        <li key={r.id} className="break-words">
          Withdrawn: {ROUTE_LABELS[r.route]}, recovered {formatIsoDate(r.recoveredOn)}. {r.reason}
        </li>
      ))}
    </ul>
  )
}
