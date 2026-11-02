import { formatDate, formatZAR } from "@/lib/utils"
import type { ChangePreview } from "@/lib/loan-changes/view"

/** The schedule a change would leave, and the figures the checker decides on. */
export function ChangePreviewTable({ preview }: { preview: ChangePreview }) {
  if (preview.refusal) return <p role="alert" className="text-sm text-[var(--cf-danger)]">{preview.refusal}</p>
  const lines: Array<[string, string]> = [
    ["Principal", formatZAR(preview.principal)],
    ["Rate", `${(preview.interestRatePm * 100).toFixed(2)}% p.m.`],
    ["Total repayable", formatZAR(preview.totalRepayable)],
    ["Last instalment", preview.maturityDate ? formatDate(preview.maturityDate) : "-"],
    ...(preview.carriedInterest + preview.carriedFees > 0 ? [["Interest and fees due, carried", formatZAR(preview.carriedInterest + preview.carriedFees)] as [string, string]] : []),
    ...(preview.settledCents > 0 ? [["Settles old loan(s)", formatZAR(preview.settledCents)] as [string, string]] : []),
    ...(preview.newMoneyCents > 0 ? [["New money", formatZAR(preview.newMoneyCents)] as [string, string]] : []),
  ]
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {lines.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-[var(--cf-text-muted)]">{label}</dt>
            <dd className="whitespace-nowrap font-medium text-[var(--cf-text)]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="max-h-64 overflow-auto rounded border border-[var(--cf-border-subtle)]">
        <table className="w-full min-w-[520px] text-xs">
          <thead className="bg-[var(--cf-surface-soft)] text-left text-[var(--cf-text-muted)]">
            <tr>{["#", "Due", "Principal", "Interest", "Fees", "Total", "Paid"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={`${row.installmentNo}-${row.dueDate}`} className="border-t border-[var(--cf-border-subtle)]">
                <td className="px-2 py-1">{row.installmentNo}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatDate(row.dueDate)}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatZAR(row.principalDue)}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatZAR(row.interestDue)}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatZAR(row.feesDue)}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatZAR(row.totalDue)}</td>
                <td className="whitespace-nowrap px-2 py-1">{formatZAR(row.totalPaid)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
