"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

type Quote = {
  sha256: string
  viewUrl: string
  figures: { amount: string; instalments: number; instalment: string; totalRepayable: string; totalCostOfCredit: string; firstDueDate: string }
}

/**
 * Before a key-facts application is submitted, in the portal or on a staff draft: the lender's key facts statement for the exact
 * terms (tender 2.2.4, lib/non-nca-documents/pre-submission.ts). Remounted when they change, so what is read is what is applied for.
 */
export function KeyFactsQuote({ endpoint, body, intro, readLabel, onRead }: {
  /** The portal's route with the terms on screen, or a staff draft's route (the draft's own terms). */
  endpoint: string
  body?: Record<string, unknown>
  intro: string
  readLabel: string
  onRead: (sha256: string | null) => void
}) {
  const [quote, setQuote] = useState<Quote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [read, setRead] = useState(false)
  // Remounted on a new amount or term: what was read for the old ones no longer counts.
  useEffect(() => { onRead(null) }, [onRead])

  async function show() {
    setBusy(true)
    setError("")
    onRead(null)
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })
      const data = await res.json().catch(() => ({}))
      if (res.ok) setQuote(data as Quote)
      else setError(typeof data.error === "string" ? data.error : "We could not prepare your key facts statement. Try again.")
    } catch {
      setError("We could not prepare your key facts statement. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] p-4 text-sm" data-testid="key-facts-quote">
      <p className="font-semibold">Key facts before you apply</p>
      {!quote ? (
        <>
          <p className="mt-1 text-[var(--cf-text-muted)]">{intro}</p>
          <button type="button" onClick={show} disabled={busy} className="mt-3 rounded border border-[var(--cf-border-strong)] px-3 py-1.5 font-semibold disabled:opacity-60">
            {busy ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Preparing</> : "Show my key facts"}
          </button>
          {error && <p role="alert" className="mt-2 text-[var(--cf-danger)]">{error}</p>}
        </>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-1">
            <dt>Loan amount</dt><dd className="font-medium">{quote.figures.amount}</dd>
            <dt>Instalments</dt><dd className="font-medium">{quote.figures.instalments} of {quote.figures.instalment}</dd>
            <dt>First instalment due</dt><dd className="font-medium">{quote.figures.firstDueDate}</dd>
            <dt>Total cost of credit</dt><dd className="font-medium">{quote.figures.totalCostOfCredit}</dd>
            <dt>Total repayable</dt><dd className="font-medium">{quote.figures.totalRepayable}</dd>
          </dl>
          <a className="mt-2 inline-block underline" href={quote.viewUrl} target="_blank" rel="noreferrer">Open the key facts statement</a>
          <label className="mt-3 flex items-start gap-2">
            <input type="checkbox" checked={read} onChange={(e) => { setRead(e.target.checked); onRead(e.target.checked ? quote.sha256 : null) }} className="mt-1" />
            <span>{readLabel}</span>
          </label>
        </>
      )}
    </div>
  )
}
