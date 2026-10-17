"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { statusLabel } from "@/lib/asset-finance/labels"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"
import type { EndOfTermOffer, EndOption } from "@/lib/asset-finance/portal-lease-view"
import { LeaseConfirm } from "./LeaseConfirm"
import { leaseApi, postLeaseAction } from "./lease-action"

interface Props {
  loanId: string
  offer: EndOfTermOffer
  chosen: PortalLeaseView["endOfTerm"]["chosen"]
  valuation: PortalLeaseView["endOfTerm"]["valuation"]
  expiryNotice?: boolean
}

const OUTCOME_LABEL: Record<EndOption, string> = {
  RETURN: "Return the asset",
  EXTEND: "Extend month to month",
  PURCHASE: "Buy the asset",
}

export function LeaseEndOfTermPanel(props: Props) {
  return (
    <div className="space-y-3">
      {props.expiryNotice && (
        <a href={`${leaseApi(props.loanId)}/documents/expiry-notice?download=1`} className="inline-block text-xs font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline">
          Download the notice about the end of your lease (PDF)
        </a>
      )}
      <EndOfTermChoice {...props} />
    </div>
  )
}

function EndOfTermChoice({ loanId, offer, chosen, valuation }: Props) {
  const router = useRouter()
  const [selected, setSelected] = useState<EndOption | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!selected) return
    setBusy(true)
    setError(null)
    const outcome = await postLeaseAction(`${leaseApi(loanId)}/end-of-term`, { outcome: selected }, "Your choice could not be recorded")
    setBusy(false)
    if (!outcome.ok) return setError(outcome.message)
    setSelected(null)
    router.refresh()
  }

  if (chosen) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[var(--cf-text)]">
          {chosen.early ? "This lease is ending early: the asset is to be returned." : `You chose to ${OUTCOME_LABEL[chosen.outcome].toLowerCase()}.`}{" "}
          <span className="text-[var(--cf-text-muted)]">Status: {statusLabel(chosen.status).toLowerCase()}.</span>
        </p>
        {chosen.inspected && (
          <a href={`${leaseApi(loanId)}/documents/inspection-report?download=1`} className="inline-block text-xs font-medium text-[var(--cf-brand)] underline-offset-2 hover:underline">
            Download the inspection report (PDF)
          </a>
        )}
      </div>
    )
  }
  if (offer.kind === "not_open") {
    return <p className="text-sm text-[var(--cf-text-muted)]">You will be able to choose what happens at the end of the lease from {formatIsoDate(offer.opensOn)}.</p>
  }
  if (offer.kind !== "open") return null

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[var(--cf-text-muted)]">The end of the lease is near. Choose what happens next; the choice cannot be changed.</p>
      <ul className="space-y-2">
        {offer.options.map((option) => (
          <li key={option}>
            <button
              type="button" aria-pressed={selected === option} onClick={() => setSelected(option)}
              className={`w-full rounded-md border px-3 py-2 text-left ${selected === option ? "border-[var(--cf-brand)] bg-[var(--cf-surface-soft)]" : "border-[var(--cf-border-strong)]"}`}
            >
              <span className="block font-semibold text-[var(--cf-text)]">{OUTCOME_LABEL[option]}</span>
              <span className="block text-xs text-[var(--cf-text-muted)]">
                {option === "RETURN" && "The asset is inspected, and any damage or excess usage is invoiced."}
                {/* Notice period of an extension (EXTENSION_NOTICE_MONTHS), signed off (see DESIGN.md sign-off record 2026-10-17). */}
                {option === "EXTEND" && "The lease continues month to month; either party may end it on a month's notice."}
                {option === "PURCHASE" && valuation && `At market value: ${formatMoney(valuation.amountExclVatCents)} excluding VAT, from the valuation of ${formatIsoDate(valuation.valuedOn)}.`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <LeaseConfirm confirmLabel="Confirm my choice" busy={busy} onCancel={() => setSelected(null)} onConfirm={confirm}>
          <p className="font-semibold">You are choosing to: {OUTCOME_LABEL[selected].toLowerCase()}.</p>
          <p className="mt-1 text-[var(--cf-text-muted)]">This cannot be changed afterwards.</p>
        </LeaseConfirm>
      )}
      {error && <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}
