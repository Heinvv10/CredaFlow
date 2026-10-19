"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { SELECT_CLASS } from "@/components/asset-finance/form-fields"
import { formatDate } from "@/lib/utils"

type Person = { clientId: string; name: string; consentAttested: boolean }
type ConsentDocument = { id: string; fileName: string; uploadedAt: string }

/**
 * POPIA consent: for the people not yet attested, the dealer user names the
 * signed consent form it uploaded and confirms the fixed statement. Evidence
 * for the lender, who verifies it before any credit check.
 */
export function DealerConsentPanel({ dealId, people, consentDocuments, statement, open }: {
  dealId: string
  people: Person[]
  consentDocuments: ConsentDocument[]
  statement: string
  open: boolean
}) {
  const router = useRouter()
  const pending = people.filter((p) => !p.consentAttested)
  const [documentId, setDocumentId] = useState(consentDocuments.length === 1 ? consentDocuments[0].id : "")
  const [chosen, setChosen] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (id: string) => setChosen((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))

  async function attest() {
    if (!documentId || chosen.length === 0 || !confirmed) return setError("Choose the consent form, the people it covers, and confirm the statement")
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/dealer/deals/${dealId}/consents`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attested: true, documentId, clientIds: chosen }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) return setError(body.error ?? `The consent could not be recorded (${res.status})`)
      setChosen([])
      setConfirmed(false)
      router.refresh()
    } catch {
      setError("Network error. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1 text-sm">
        {people.length === 0 ? <li className="text-[var(--cf-text-muted)]">No people on this deal yet.</li> : people.map((p) => (
          <li key={p.clientId} className="flex justify-between gap-3">
            <span className="text-[var(--cf-text)]">{p.name}</span>
            <span className={p.consentAttested ? "text-[var(--cf-success)]" : "text-[var(--cf-warning)]"}>{p.consentAttested ? "Consent attested" : "Consent needed"}</span>
          </li>
        ))}
      </ul>
      {open && pending.length > 0 ? (
        consentDocuments.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">Upload the signed POPIA consent form under Documents first (type &quot;POPIA consent&quot;).</p>
        ) : (
          <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-3">
            <div>
              <label htmlFor="consent-document" className="mb-1.5 block text-xs font-semibold text-[var(--cf-text-secondary)]">Signed consent form</label>
              <select id="consent-document" className={SELECT_CLASS} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                <option value="">Choose…</option>
                {consentDocuments.map((d) => <option key={d.id} value={d.id}>{d.fileName} ({formatDate(d.uploadedAt)})</option>)}
              </select>
            </div>
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-semibold text-[var(--cf-text-secondary)]">People the form covers</legend>
              {pending.map((p) => (
                <label key={p.clientId} className="flex items-center gap-2 text-sm text-[var(--cf-text)]">
                  <input type="checkbox" checked={chosen.includes(p.clientId)} onChange={() => toggle(p.clientId)} />
                  {p.name}
                </label>
              ))}
            </fieldset>
            <blockquote className="border-l-2 border-[var(--cf-border-strong)] pl-3 text-sm text-[var(--cf-text-secondary)]">{statement}</blockquote>
            <label className="flex items-start gap-2 text-sm text-[var(--cf-text)]">
              <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I confirm the statement above for each person I chose.
            </label>
            {error ? <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p> : null}
            <Button size="sm" onClick={attest} disabled={saving}>{saving ? "Saving…" : "Attest consent"}</Button>
          </div>
        )
      ) : null}
    </div>
  )
}
