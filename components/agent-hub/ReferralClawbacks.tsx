import Link from "next/link"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { formatZAR } from "@/lib/loan-calculator"

export type ClawbackEvent = {
  id: string
  commissionCents: number | null
  createdAt: string
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  loanId: string | null
  loanReference: string | null
}

function money(cents: number | null) {
  if (!cents) return "—"
  return formatZAR(cents)
}

export function ReferralClawbacks({ clawbacks }: { clawbacks: ClawbackEvent[] }) {
  return (
    <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
      <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
        <h2 className="font-semibold text-[var(--cf-text)]">Clawbacks</h2>
        <p className="mt-1 text-xs text-gray-500">Commission reversed after the loan defaulted. Reversal date/reason are not tracked separately — the date shown is when the commission was accrued.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-sm">
          <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Code</th>
              <th className="px-5 py-3">Loan</th>
              <th className="px-5 py-3">Amount</th>
              <th className="px-5 py-3">Accrued</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--cf-border-subtle)]">
            {clawbacks.map((clawback) => (
              <tr key={clawback.id} className="text-[var(--cf-text-secondary)]">
                <td className="px-5 py-4">{clawback.code?.agent.displayName ?? "—"}</td>
                <td className="px-5 py-4">{clawback.code ? <span className="font-mono text-[var(--cf-warning)]">{clawback.code.code}</span> : "—"}</td>
                <td className="px-5 py-4">
                  {clawback.loanId ? (
                    <Link href={`/loans/${clawback.loanId}`} className="text-[var(--cf-warning)] hover:underline">{clawback.loanReference ?? clawback.loanId}</Link>
                  ) : "—"}
                </td>
                <td className="px-5 py-4 font-semibold text-[var(--cf-danger)]">{money(clawback.commissionCents)}</td>
                <td className="px-5 py-4 text-xs text-gray-500">{new Date(clawback.createdAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}</td>
              </tr>
            ))}
            {clawbacks.length === 0 ? <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-500">No clawbacks recorded.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
