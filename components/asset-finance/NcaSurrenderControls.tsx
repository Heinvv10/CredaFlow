"use client"
import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
const field = "rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg)] p-2 text-sm"
const button = "rounded bg-[var(--cf-brand)] px-3 py-2 text-sm text-[var(--cf-on-brand)] disabled:opacity-50"
export function NcaSurrenderControls({ loanId, surrenders, recovery, accountStatus, instructions, canRequest, canManage, canDecide, canRecordPayment }: {
  loanId: string; canRequest: boolean; instructions: { id: string; status: string; amountCents: number }[]; surrenders: { id: string; status: string; receivedOn: string | null }[];
  recovery: { id: string; receivedOn: string | null } | null; accountStatus: string; canManage: boolean; canDecide: boolean; canRecordPayment: boolean;
}) {
  const router = useRouter()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function post(path: string, body?: unknown) {
    setError(""); setBusy(true)
    try {
      const multipart = body instanceof FormData
      const response = await fetch(path, { method: "POST", ...(body ? { headers: multipart ? undefined : { "Content-Type": "application/json" }, body: multipart ? body : JSON.stringify(body) } : {}) })
      if (!response.ok) { const data = await response.json(); setError(data.error ?? "Action refused"); return }
      router.refresh()
    } catch { setError("The action could not be sent") } finally { setBusy(false) }
  }
  function form(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget) }
  const active = surrenders.find((s) => !["WITHDRAWN", "FINAL_NOTICE_ISSUED"].includes(s.status))
  const base = `/api/asset-finance/surrenders/${active?.id}`
  const accountBase = `/api/asset-finance/loans/${loanId}/surplus-account`
  const receiptForm = (path: string) => <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(path, { receivedOn: f.get("receivedOn"), reference: f.get("reference"), issuedOn: f.get("issuedOn") || undefined }) }}>
    <label>Notice received on <input className={field} type="date" name="receivedOn" required /></label>
    <label>Delivery evidence reference <input className={field} name="reference" required minLength={10} maxLength={1000} /></label>
    <label>Historical notice issue date (imported notices only) <input className={field} name="issuedOn" type="date" /></label><button className={button} disabled={busy}>Record valuation notice receipt</button>
  </form>
  return <section id="nca-surrender" className="space-y-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
    <h2 className="font-semibold">NCA surrender and surplus</h2>
    {error && <p role="alert" className="text-[var(--cf-danger)]">{error}</p>}
    {active ? <>
      <p>Surrender status: {active.status.replaceAll("_", " ")}</p>
      {canManage && active.status === "REQUESTED" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(`${base}/valuation`, { valuedOn: f.get("valuedOn"), source: "ASSESSOR", valuerName: f.get("valuerName"), amountCents: Math.round(Number(f.get("amount")) * 100) }) }}>
        <label>Valuation date <input className={field} name="valuedOn" type="date" required /></label><label>Assessor <input className={field} name="valuerName" required /></label><label>Valuation (R) <input className={field} name="amount" type="number" min="0.01" step="0.01" required /></label><button className={button} disabled={busy}>Record surrender valuation</button>
      </form>}
      {canManage && active.status === "VALUED" && <button className={button} disabled={busy} onClick={() => void post(`${base}/valuation-notice`)}>Issue surrender valuation notice</button>}
      {canManage && ["VALUATION_NOTICE_ISSUED", "PROCEEDS_CREDITED"].includes(active.status) && !active.receivedOn && receiptForm(`${base}/valuation-receipt`)}
      {active.receivedOn && <p>Valuation notice received: {active.receivedOn}. Sale is refused until the ten-business-day window has ended.</p>}
      {canManage && active.status === "VALUATION_NOTICE_ISSUED" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(`${base}/withdraw`, { goodsReturnReference: f.get("reference") }) }}>
        <label>Signed goods-return reference <input className={field} name="reference" minLength={10} required /></label><button className={button} disabled={busy}>Record withdrawal and return of goods</button>
      </form>}
      {canRecordPayment && active.status === "VALUATION_NOTICE_ISSUED" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(`${base}/proceeds`, { saleProceedsCents: Math.round(Number(f.get("amount")) * 100) }) }}>
        <label>Sale proceeds (R) <input className={field} name="amount" type="number" min="0.01" step="0.01" required /></label><button className={button} disabled={busy}>Credit surrender sale proceeds</button>
      </form>}
      {canManage && active.status === "PROCEEDS_CREDITED" && <button className={button} disabled={busy} onClick={() => void post(`${base}/final-notice`)}>Issue final notice and surplus payment instruction</button>}
    </> : canManage && canRequest && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(`/api/asset-finance/loans/${loanId}/surrender`, { assetCondition: f.get("condition") }) }}><label>Asset condition <input className={field} name="condition" minLength={3} required /></label><button className={button} disabled={busy}>Record surrender request</button></form>}
    {recovery && canManage && !recovery.receivedOn && receiptForm(`/api/asset-finance/recoveries/${recovery.id}/valuation-receipt`)}
    <div className="space-y-2">{canManage && accountStatus !== "missing" && <a className="underline" href={`${accountBase}/document`} target="_blank" rel="noreferrer">Review bank verification evidence</a>}<h3 className="font-semibold">Surplus bank account</h3><p>Status: {accountStatus}. Collect proof of the consumer’s account at valuation; another staff member verifies it and a third authorises release before the final notice.</p>
      {canManage && accountStatus === "missing" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); f.set("docType", "BANK_STATEMENT"); void post(`${accountBase}/record`, f) }}>
        {[["accountHolder", "Account holder"], ["bankName", "Bank"], ["branchCode", "Branch code"], ["accountNumber", "Account number"]].map(([name,label]) => <label key={name}>{label} <input className={field} name={name} required /></label>)}<label>Proof of account <input name="file" type="file" accept="application/pdf,image/*" required /></label><button className={button} disabled={busy}>Record bank account and proof</button>
      </form>}
      {canDecide && accountStatus === "awaiting verification" && <button className={button} disabled={busy} onClick={() => void post(`${accountBase}/approve`)}>Verify consumer bank account</button>}
      {canDecide && accountStatus === "awaiting release authority" && <button className={button} disabled={busy} onClick={() => void post(`${accountBase}/authorise`)}>Authorise surplus release</button>}
    </div>
    {instructions.map((i) => <p key={i.id}>Surplus {(i.amountCents / 100).toFixed(2)}: {i.status === "INSTRUCTED" ? canRecordPayment ? <a className="underline" href={`/api/asset-finance/loans/${loanId}/surplus-instructions/${i.id}`}>Download payment instruction</a> : "Payment instruction issued" : "Held — no verified bank account (recorded exception)"}</p>)}
    {surrenders.map((s) => <p key={s.id}>Surrender {s.id}: {s.status.replaceAll("_", " ")} · <a className="underline" href={`/api/asset-finance/surrenders/${s.id}/documents/valuation`}>Valuation notice</a> · <a className="underline" href={`/api/asset-finance/surrenders/${s.id}/documents/final`}>Final notice</a></p>)}
  </section>
}
