"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { changeTitle, emptyForm, FIELDS_OF, formPayload, type ChangeFormValues } from "@/lib/loan-changes/form"
import { LOAN_CHANGE_LABELS, IN_PLACE_TYPES, NEW_LOAN_TYPES, type LoanChangeType } from "@/lib/loan-changes/types"
import type { ChangePreview, LoanChangesView } from "@/lib/loan-changes/view"
import { ChangePreviewTable } from "./ChangePreviewTable"

const inputRow = "space-y-1 text-sm"
const hint = "text-xs text-[var(--cf-text-muted)]"
const selectClass = "h-10 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg-panel)] px-3 text-sm text-[var(--cf-text)]"

async function post(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { ok: response.ok, json: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Drafts a change, shows what it would do, and files it for a second person. Nothing here changes the loan. */
export function ProposeChangeForm({ loanId, reference, view }: { loanId: string; reference: string; view: LoanChangesView }) {
  const router = useRouter()
  const types: LoanChangeType[] = [...(view.inPlaceRefusal ? [] : IN_PLACE_TYPES), ...(view.newLoanRefusal ? [] : NEW_LOAN_TYPES)]
  const [form, setForm] = useState<ChangeFormValues>(emptyForm(types[0]!))
  const [preview, setPreview] = useState<ChangePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fields = FIELDS_OF[form.type]
  const set = (patch: Partial<ChangeFormValues>) => { setForm({ ...form, ...patch }); setPreview(null) }

  async function runPreview() {
    setBusy(true)
    setError(null)
    const { ok, json } = await post(`/api/loans/${loanId}/changes/preview`, formPayload(loanId, form))
    setBusy(false)
    if (ok) setPreview(json as unknown as ChangePreview)
    else setError(((json.problems as string[] | undefined) ?? [String(json.error ?? "Could not preview this change")]).join(". "))
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const drafted = await post("/api/maker-checker", { kind: "LOAN_CHANGE", title: changeTitle(form.type, reference), payload: formPayload(loanId, form) })
    const id = (drafted.json.request as { id?: string } | undefined)?.id
    const submitted = id ? await post(`/api/maker-checker/${id}/submit`, {}) : drafted
    if (!submitted.ok) {
      setBusy(false)
      setError(String(submitted.json.error ?? "Could not file this change"))
      if (id) await post(`/api/maker-checker/${id}/withdraw`, {})
      return
    }
    setBusy(false)
    setForm(emptyForm(form.type))
    setPreview(null)
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <div className={inputRow}>
        <label htmlFor="lc-type" className="font-medium">Change</label>
        <select id="lc-type" className={selectClass} value={form.type} onChange={(e) => { setForm(emptyForm(e.target.value as LoanChangeType)); setPreview(null) }}>
          {types.map((type) => <option key={type} value={type}>{LOAN_CHANGE_LABELS[type]}</option>)}
        </select>
      </div>
      {fields.includes("firstDue") && (
        <div className={inputRow}>
          <label htmlFor="lc-first-due" className="font-medium">New first instalment date</label>
          <Input id="lc-first-due" type="date" value={form.firstDueDate} onChange={(e) => set({ firstDueDate: e.target.value })} />
          <p className={hint}>On or after the next instalment. Arrears move into the new instalments at the amount owed; the extra days earn simple interest.</p>
        </div>
      )}
      {fields.includes("holiday") && (
        <div className={inputRow}>
          <label htmlFor="lc-holiday" className="font-medium">Instalments to skip</label>
          <Input id="lc-holiday" inputMode="numeric" value={form.holidayInstalments} onChange={(e) => set({ holidayInstalments: e.target.value })} />
          <p className={hint}>Interest keeps running and is spread over the later instalments, without interest on it.</p>
        </div>
      )}
      {fields.includes("newMoney") && (
        <>
          <div className={inputRow}>
            <label htmlFor="lc-new-money" className="font-medium">New money</label>
            <Input id="lc-new-money" inputMode="decimal" value={form.newMoney} onChange={(e) => set({ newMoney: e.target.value })} />
          </div>
          <div className={inputRow}>
            <label htmlFor="lc-payout-ref" className="font-medium">Transfer reference</label>
            <Input id="lc-payout-ref" value={form.payoutReference} onChange={(e) => set({ payoutReference: e.target.value })} />
            <p className={hint}>The payout is manual: no money moves in the system.</p>
          </div>
        </>
      )}
      {fields.includes("otherLoans") && (
        <fieldset className={inputRow}>
          <legend className="font-medium">Loans to consolidate with this one</legend>
          {view.otherLoans.length === 0 && <p className={hint}>This borrower has no other open loan.</p>}
          {view.otherLoans.map((loan) => (
            <label key={loan.id} className="flex items-center gap-2">
              <input
                type="checkbox" checked={form.otherLoanIds.includes(loan.id)}
                onChange={(e) => set({ otherLoanIds: e.target.checked ? [...form.otherLoanIds, loan.id] : form.otherLoanIds.filter((id) => id !== loan.id) })}
              />
              {loan.reference}
            </label>
          ))}
        </fieldset>
      )}
      {fields.includes("rate") && (
        <div className={inputRow}>
          <label htmlFor="lc-rate" className="font-medium">Rate, % a month</label>
          <Input id="lc-rate" inputMode="decimal" value={form.ratePercent} onChange={(e) => set({ ratePercent: e.target.value })} />
          {form.type !== "RATE_CHANGE" && <p className={hint}>Blank keeps the current rate.</p>}
        </div>
      )}
      {fields.includes("instalments") && (
        <div className={inputRow}>
          <label htmlFor="lc-instalments" className="font-medium">Instalments from now</label>
          <Input id="lc-instalments" inputMode="numeric" value={form.instalments} onChange={(e) => set({ instalments: e.target.value })} />
        </div>
      )}
      <div className={inputRow}>
        <label htmlFor="lc-document" className="font-medium">Signed variation or agreement</label>
        <select id="lc-document" className={selectClass} value={form.signedDocumentId} onChange={(e) => set({ signedDocumentId: e.target.value })}>
          <option value="">Choose from the borrower&apos;s documents</option>
          {view.documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.fileName}</option>)}
        </select>
        <p className={hint}>On the lender&apos;s own wording, signed by the borrower. Upload it to the client first.</p>
      </div>
      <div className={inputRow}>
        <label htmlFor="lc-reason" className="font-medium">Why</label>
        <Textarea id="lc-reason" rows={2} value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      {preview && <ChangePreviewTable preview={preview} />}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={runPreview}>Preview</Button>
        <Button type="button" disabled={busy || !preview || preview.refusal !== null} onClick={submit}>Submit for approval</Button>
      </div>
    </div>
  )
}
