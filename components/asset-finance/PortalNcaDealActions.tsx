"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export interface PortalNcaDealAction {
  dealId: string
  reference: string
  stage: "CREDIT_LIFE" | "QUOTE"
  documentId?: string
  documentSha256?: string
}

export function PortalNcaDealActions({ entityId, actions }: { entityId: string; actions: PortalNcaDealAction[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function post(action: PortalNcaDealAction) {
    setBusy(action.dealId)
    setError(null)
    const quote = action.stage === "QUOTE"
    try {
      const response = await fetch(quote
        ? `/api/portal/asset-finance/deals/${action.dealId}/nca-quote/acknowledge`
        : `/api/portal/asset-finance/deals/${action.dealId}/credit-life`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quote ? { documentSha256: action.documentSha256 } : { election: "DECLINED" }),
      })
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        setError(body.error ?? "The action could not be recorded")
        return
      }
      router.refresh()
    } catch {
      setError("The action could not be sent")
    } finally {
      setBusy(null)
    }
  }

  if (actions.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No NCA actions are waiting.</p>
  return (
    <div className="space-y-3">
      {actions.map((action) => {
        const quoteUrl = action.documentId ? `/api/portal/asset-finance/entities/${entityId}/documents/${action.documentId}` : null
        return (
          <div key={action.dealId} className="rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm">
            <p className="font-mono text-xs text-[var(--cf-text-muted)]">{action.reference}</p>
            {action.stage === "CREDIT_LIFE" ? (
              <>
                <p className="mt-1 text-[var(--cf-text)]">Record that the entity proceeds without bundled natural-person credit-life cover.</p>
                <button type="button" disabled={busy === action.dealId} onClick={() => post(action)} className="mt-2 rounded-md bg-[var(--cf-brand)] px-3 py-2 font-semibold text-[var(--cf-on-brand)] disabled:opacity-50">Proceed without cover</button>
              </>
            ) : (
              <>
                <p className="mt-1 text-[var(--cf-text)]">Open the exact draft NCA quotation, review its costs, then acknowledge it.</p>
                {quoteUrl && <a href={quoteUrl} target="_blank" rel="noreferrer" onClick={() => setOpened(action.dealId)} className="mt-2 inline-block text-[var(--cf-brand)] underline">Open quotation</a>}
                <button type="button" disabled={busy === action.dealId || opened !== action.dealId} onClick={() => post(action)} className="ml-3 mt-2 rounded-md bg-[var(--cf-brand)] px-3 py-2 font-semibold text-[var(--cf-on-brand)] disabled:opacity-50">Acknowledge quotation</button>
              </>
            )}
          </div>
        )
      })}
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}
