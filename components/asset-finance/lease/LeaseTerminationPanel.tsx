import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { canAcceptQuote, canRequestQuote } from "@/lib/asset-finance/lease-staff-actions"
import { LeaseActionButton } from "./LeaseActionButton"
import type { LeaseStaffData, QuoteRow } from "./lease-staff-data"

// Early-termination quotes: request one, read what it is made of, accept a
// live one on the lessee's instruction (lib/asset-finance/lease-termination-store.ts).
// Accepting cancels the rentals after the termination date, invoices the
// amount and opens a return.

const link = "text-[var(--cf-text-secondary)] underline-offset-2 hover:underline"

function quoteTone(q: QuoteRow, today: string): { tone: "success" | "warning" | "info"; label: string } {
  if (q.status === "ACCEPTED") return { tone: "success", label: "Accepted" }
  return q.validUntil < today ? { tone: "warning", label: "Expired" } : { tone: "info", label: "Quoted" }
}

export function LeaseTerminationPanel({ data, canManage, canDecide }: { data: LeaseStaffData; canManage: boolean; canDecide: boolean }) {
  const base = `/api/asset-finance/leases/${data.loanId}/termination-quotes`
  const request = canRequestQuote({ loanStatus: data.loanStatus, hasEndOfTerm: data.endOfTerm !== null, canManage })
  return (
    <DataPanel
      title="Early termination"
      description={`Ending a lease early is by quotation only, at a penalty of ${(Number(data.deal.earlyTerminationPenaltyRate) * 100).toFixed(2)}% on the present value of the remaining rentals. The asset still comes back.`}
      actions={request ? <LeaseActionButton url={base} label="Request a quote" busyLabel="Quoting…" variant="outline" /> : undefined}
      density="loose"
    >
      {data.quotes.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">No early-termination quote has been requested.</p>
      ) : (
        <div className="space-y-4">
          {data.quotes.map((q) => {
            const status = quoteTone(q, data.today)
            const accept = canAcceptQuote({ quoteStatus: q.status, validUntil: q.validUntil, today: data.today, loanStatus: data.loanStatus, hasEndOfTerm: data.endOfTerm !== null, canDecide })
            return (
              <div key={q.id} className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--cf-text)]">
                    Quote of {formatIsoDate(q.quotedOn)} · terminates {formatIsoDate(q.terminationDate)} · valid to {formatIsoDate(q.validUntil)}
                  </p>
                  <StatusPill tone={status.tone}>{status.label}</StatusPill>
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                  {[
                    [`Present value (${q.remainingRentals} rentals)`, q.pvCents],
                    ["Penalty", q.penaltyCents],
                    ["Arrears", q.arrearsCents],
                    ["VAT", q.invoiceVatCents],
                    ["Total to pay", q.totalCents],
                  ].map(([label, cents]) => (
                    <div key={label}>
                      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
                      <dd className="whitespace-nowrap font-semibold text-[var(--cf-text)]">{formatMoney(cents as number)}</dd>
                    </div>
                  ))}
                </dl>
                {q.cpaCancellation && <p className="text-xs text-[var(--cf-text-muted)]">The lessee is a consumer under the CPA: cancellation is on 20 business days&apos; notice.</p>}
                <p className="text-xs text-[var(--cf-text-muted)]">{q.basis}</p>
                <p className="text-sm text-[var(--cf-text)]">
                  <a className={link} href={`/api/asset-finance/leases/${data.loanId}/documents/termination-quote?quoteId=${encodeURIComponent(q.id)}`} target="_blank" rel="noopener noreferrer">Quote PDF</a>
                  {q.invoice && (
                    <>
                      {" · "}Invoice{" "}
                      <a className={link} href={`/api/asset-finance/tax-invoices/${q.invoice.id}`} target="_blank" rel="noopener noreferrer">{q.invoice.number}</a>
                    </>
                  )}
                </p>
                {accept && <LeaseActionButton url={`${base}/${q.id}/accept`} label="Accept on the lessee's instruction" busyLabel="Accepting…" />}
              </div>
            )
          })}
        </div>
      )}
    </DataPanel>
  )
}
