import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { ChargesActions } from "@/components/loans/ChargesActions"
import { CHARGE_TYPE_LABELS, chargeBucketRows, type LoanChargesView } from "@/lib/loan/charges-summary"
import { formatDate, formatZAR } from "@/lib/utils"

/**
 * Default charges on one loan (lib/loan/charges-summary.ts): per-type totals,
 * the dated postings, the in duplum position, and the staff actions. `charges`
 * is null while charges are off for the tenant; the panel then carries only the
 * small-balance waiver, when the loan qualifies for one.
 */
export function ChargesPanel({ loanId, charges, waivable, settlementAmount, canManage, chargesNotDerived }: {
  loanId: string
  charges: LoanChargesView | null
  waivable: boolean
  /** charge-inclusive settlement today, cents */
  settlementAmount: number
  canManage: boolean
  /** why the latest Section 129 notice's admin charge was not posted (lib/loan/loan-page-figures.ts) */
  chargesNotDerived: string | null
}) {
  return (
    <DataPanel
      title="Default charges"
      description={charges
        ? `Charging from ${charges.goLive ? formatDate(charges.goLive) : "go-live"}`
        : "Default charges are off for this lender"}
      variant="default"
      density="loose"
      actions={charges?.exempt ? <StatusPill tone="neutral">Exempt</StatusPill> : undefined}
    >
      {chargesNotDerived && (
        <p className="mb-4 rounded-md border border-[var(--cf-warning)] p-3 text-sm text-[var(--cf-warning)]">
          The latest Section 129 notice was recorded, but its admin charge was not posted: {chargesNotDerived}
        </p>
      )}
      {charges && (
        <div className="space-y-4 text-sm">
          {charges.exempt ? (
            <p className="text-[var(--cf-text-muted)]">
              Exempt from default charges: {charges.exemptReason}
            </p>
          ) : (
            <p className="text-[var(--cf-text-muted)]">
              This loan can be charged from {charges.accrueFrom ? formatDate(charges.accrueFrom) : "—"}.
            </p>
          )}

          {/* Scrolls sideways on a phone rather than clipping the money columns. */}
          <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="text-left text-xs text-[var(--cf-text-muted)]">
                <th className="py-1 pr-3 font-medium">Charge</th>
                <th className="py-1 pl-3 text-right font-medium">Charged</th>
                <th className="py-1 pl-3 text-right font-medium">Paid</th>
                <th className="py-1 pl-3 text-right font-medium">Owing</th>
              </tr>
            </thead>
            <tbody>
              {chargeBucketRows(charges).map(({ type, bucket }) => (
                <tr key={type} className="border-t border-[var(--cf-border-subtle)]">
                  <td className="py-1.5 text-[var(--cf-text)]">{CHARGE_TYPE_LABELS[type]}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatZAR(bucket.accrued)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatZAR(bucket.paid)}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{formatZAR(bucket.outstanding)}</td>
                </tr>
              ))}
              <tr className="border-t border-[var(--cf-border-strong)]">
                <td className="py-1.5 font-semibold">Total owing</td>
                <td colSpan={3} className="py-1.5 text-right font-bold tabular-nums">{formatZAR(charges.outstanding)}</td>
              </tr>
            </tbody>
          </table>
          </div>

          {charges.inDuplum && (
            <p className="text-[var(--cf-text-muted)]">
              In duplum (s103(5)): {formatZAR(charges.inDuplum.accrued)} of {formatZAR(charges.inDuplum.capBase)} used
              {charges.inDuplum.reached ? " — cap reached, nothing further accrues" : ""}.
            </p>
          )}

          {charges.postings.length > 0 && (
            <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-xs">
              <thead>
                <tr className="text-left text-[var(--cf-text-muted)]">
                  <th className="py-1 pr-3 font-medium">Date</th>
                  <th className="py-1 pr-3 font-medium">Charge</th>
                  <th className="py-1 pr-3 font-medium">Source</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {charges.postings.map((posting, i) => (
                  <tr key={i} className="border-t border-[var(--cf-border-subtle)]">
                    <td className="py-1">{formatDate(new Date(`${posting.day}T00:00:00.000Z`))}</td>
                    <td className="py-1">{CHARGE_TYPE_LABELS[posting.type]}</td>
                    <td className="py-1 font-mono text-[var(--cf-text-muted)]">{posting.sourceId ?? "—"}</td>
                    <td className="py-1 text-right tabular-nums">{formatZAR(posting.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <ChargesActions
          loanId={loanId}
          chargesLive={charges !== null}
          exempt={charges?.exempt ?? false}
          waivable={waivable}
          settlementAmount={settlementAmount}
        />
      )}
    </DataPanel>
  )
}
