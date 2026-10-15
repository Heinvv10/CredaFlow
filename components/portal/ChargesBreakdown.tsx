import { formatZAR } from "@/lib/utils"

/**
 * One plain line under an amount that includes default charges, e.g.
 * "Includes: Default interest R 30.00 · Collection letter fee R 82.00".
 * Labels come from CHARGE_TYPE_LABELS (lib/loan/charges-summary.ts).
 */
export function ChargesBreakdown({ lines, className = "", prefix = "Includes:" }: {
  lines: Array<{ label: string; amount: number }>
  className?: string
  /** The translated "Includes:" (portalLabels.chargesIncludes). Charge names stay English, as on the NCA documents. */
  prefix?: string
}) {
  if (lines.length === 0) return null
  return (
    <p className={`text-xs text-[var(--cf-text-muted)] ${className}`}>
      {prefix} {lines.map((line) => `${line.label} ${formatZAR(line.amount)}`).join(" · ")}
    </p>
  )
}
