"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import type { PortalLeaseQuote } from "@/lib/asset-finance/portal-lease"
import type { TerminationActions } from "@/lib/asset-finance/portal-lease-view"
import { LeaseConfirm } from "./LeaseConfirm"
import { leaseApi, postLeaseAction } from "./lease-action"

interface Props {
  loanId: string
  quote: PortalLeaseQuote | null
  actions: TerminationActions
}

const STATE_PILL = {
  VALID: { label: "Valid", tone: "success" },
  EXPIRED: { label: "Expired", tone: "warning" },
  ACCEPTED: { label: "Accepted", tone: "info" },
} as const

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? "border-t border-[var(--cf-border-subtle)] pt-2 font-semibold" : ""}`}>
      <dt className="text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="whitespace-nowrap text-[var(--cf-text)]">{value}</dd>
    </div>
  )
}

export function LeaseTerminationPanel({ loanId, quote, actions }: Props) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(path: string, failure: string) {
    setBusy(true)
    setError(null)
    const outcome = await postLeaseAction(`${leaseApi(loanId)}/${path}`, {}, failure)
    setBusy(false)
    if (!outcome.ok) return setError(outcome.message)
    setConfirming(false)
    router.refresh()
  }

  const pill = actions.state === "NONE" ? null : STATE_PILL[actions.state]
  return (
    <div className="space-y-4 text-sm">
      {!quote && actions.canRequest && <p className="text-[var(--cf-text-muted)]">You can ask what it would cost to end this lease early. A quote commits you to nothing until you accept it.</p>}
      {quote && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[var(--cf-text)]">Quote of {formatIsoDate(quote.quotedOn)}</span>
            {pill && <StatusPill tone={pill.tone}>{pill.label}</StatusPill>}
          </div>
          <dl className="max-w-md space-y-1.5">
            <Line label="Lease ends on" value={formatIsoDate(quote.terminationDate)} />
            <Line label="Rentals cancelled" value={String(quote.remainingRentals)} />
            <Line label="Present value of those rentals" value={formatMoney(quote.pvCents)} />
            <Line label="Early-termination penalty" value={formatMoney(quote.penaltyCents)} />
            <Line label="VAT" value={formatMoney(quote.invoiceVatCents)} />
            <Line label="Rentals already overdue" value={formatMoney(quote.arrearsCents)} />
            <Line label="Total to pay" value={formatMoney(quote.totalCents)} strong />
          </dl>
          <p className="text-xs text-[var(--cf-text-muted)]">
            {actions.state === "ACCEPTED" ? "Accepted" : actions.state === "EXPIRED" ? "Expired" : "Valid"} until {formatIsoDate(quote.validUntil)}.
          </p>
          <div>
            <p className="text-xs font-semibold text-[var(--cf-text)]">How this was worked out</p>
            <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{quote.basis}</p>
          </div>
        </div>
      )}
      {!confirming && (actions.canAccept || actions.canRequest) && (
        <div className="flex flex-wrap gap-2">
          {actions.canAccept && (
            <button type="button" onClick={() => setConfirming(true)} className="rounded-md bg-[var(--cf-brand)] px-4 py-2 font-semibold text-[var(--cf-on-brand)]">
              Accept this quote
            </button>
          )}
          {actions.canRequest && (
            <button type="button" onClick={() => send("termination-quotes", "The quote could not be requested")} disabled={busy}
              className="rounded-md border border-[var(--cf-border-strong)] px-4 py-2 font-semibold text-[var(--cf-text)] disabled:opacity-50">
              {busy ? "Requesting…" : quote ? "Request a new quote" : "Request a quote"}
            </button>
          )}
        </div>
      )}
      {confirming && quote && (
        <LeaseConfirm confirmLabel="Yes, end the lease early" busy={busy} onCancel={() => setConfirming(false)}
          onConfirm={() => send(`termination-quotes/${quote.id}/accept`, "The quote could not be accepted")}>
          {/* UNTESTED: legal — wording of the acceptance consequences. */}
          <p className="font-semibold">Accepting cannot be undone.</p>
          <p className="mt-1 text-[var(--cf-text-muted)]">
            The remaining rentals are cancelled, you are invoiced {formatMoney(quote.totalCents - quote.arrearsCents)} (including VAT) and the asset must be returned.
          </p>
        </LeaseConfirm>
      )}
      {error && <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}
