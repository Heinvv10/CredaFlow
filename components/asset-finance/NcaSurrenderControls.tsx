"use client"
import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
const field = "rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg)] p-2 text-sm"
const button = "rounded bg-[var(--cf-brand)] px-3 py-2 text-sm text-[var(--cf-on-brand)] disabled:opacity-50"
export function NcaSurrenderControls({ loanId, surrenders, recovery, accountStatus, determination, instructions, canRequest, canManage, canDecide, canRecordPayment }: {
  determination: "UNKNOWN" | "TRIBUNAL" | "CONSUMER"; loanId: string; canRequest: boolean; instructions: { id: string; status: string; amountCents: number; accountId: string | null; executedOn: string | null }[]; surrenders: { id: string; status: string; receivedOn: string | null }[];
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
      {canManage && active.status === "PROCEEDS_CREDITED" && <button className={button} disabled={busy} onClick={() => void post(`${base}/final-notice`)}>Issue final notice after remittance (or account exception)</button>}
    </> : canManage && canRequest && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); void post(`/api/asset-finance/loans/${loanId}/surrender`, { assetCondition: f.get("condition") }) }}><label>Asset condition <input className={field} name="condition" minLength={3} required /></label><button className={button} disabled={busy}>Record surrender request</button></form>}
    {recovery && canManage && !recovery.receivedOn && receiptForm(`/api/asset-finance/recoveries/${recovery.id}/valuation-receipt`)}
    <div className="space-y-2">
      <h3 className="font-semibold">Competing registered credit agreement determination</h3>
      <p>Recipient: {determination}. Establish whether another credit provider has a registered credit agreement with this same consumer concerning these same goods. Unknown is not no.</p>
      {determination !== "UNKNOWN" && canManage && <a className="underline" href={`/api/asset-finance/loans/${loanId}/surplus-determination`}>Review determination evidence</a>}
      {canDecide && determination === "UNKNOWN" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); f.set("docType", "OTHER"); void post(`/api/asset-finance/loans/${loanId}/surplus-determination`, f) }}>
        <label>Another credit provider has a registered credit agreement with this consumer concerning these same goods <select className={field} name="competingAgreement" required defaultValue=""><option value="" disabled>Unknown — investigate first</option><option value="NO">No — remit to consumer</option><option value="YES">Yes — remit to Tribunal</option></select></label>
        <label>Evidence and determination basis <textarea className={field} name="basis" required minLength={20} maxLength={2000} /></label>
        <label>Retained enquiry/creditor evidence <input name="file" type="file" accept="application/pdf,image/*" required /></label>
        <button className={button} disabled={busy}>Record evidenced determination</button>
      </form>}
    </div>
    <div className="space-y-2">{canManage && accountStatus !== "missing" && <a className="underline" href={`${accountBase}/document`} target="_blank" rel="noreferrer">Review bank verification evidence</a>}<h3 className="font-semibold">Surplus {determination === "TRIBUNAL" ? "Tribunal" : "consumer"} bank account</h3><p>Status: {accountStatus}. Collect proof of the correct recipient’s account at valuation; another staff member verifies it and a third authorises release before the final notice.</p>
      {canManage && determination !== "UNKNOWN" && accountStatus === "missing" && <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); f.set("docType", "BANK_STATEMENT"); void post(`${accountBase}/record`, f) }}>
        {[["accountHolder", "Account holder"], ["bankName", "Bank"], ["branchCode", "Branch code"], ["accountNumber", "Account number"]].map(([name,label]) => <label key={name}>{label} <input className={field} name={name} required /></label>)}<label>Proof of account <input name="file" type="file" accept="application/pdf,image/*" required /></label><button className={button} disabled={busy}>Record bank account and proof</button>
      </form>}
      {canDecide && accountStatus === "awaiting verification" && <button className={button} disabled={busy} onClick={() => void post(`${accountBase}/approve`)}>Verify surplus recipient bank account</button>}
      {canDecide && accountStatus === "awaiting release authority" && <button className={button} disabled={busy} onClick={() => void post(`${accountBase}/authorise`)}>Authorise surplus release</button>}
    </div>
    {canRecordPayment && determination !== "UNKNOWN" && instructions.length === 0 && <button className={button} disabled={busy} onClick={() => void post(`/api/asset-finance/loans/${loanId}/surplus-instructions`)}>Prepare surplus instruction after actual sale proceeds</button>}
    {instructions.map((i) => <div key={i.id} className="space-y-2">
      <p>Surplus {(i.amountCents / 100).toFixed(2)}: {i.executedOn ? `Bank execution evidenced on ${i.executedOn}` : i.status === "INSTRUCTED" ? "Payment instruction issued; payment outstanding. The loan debt is settled, but the surplus remains due to the consumer." : "Held — no verified bank account (recorded exception). Surplus remains payable; no statutory termination under s127(6)(b) until actual remittance."}</p>
      {i.status === "INSTRUCTED" && canRecordPayment && <>
        <a className="underline" href={`/api/asset-finance/loans/${loanId}/surplus-instructions/${i.id}`}>Download payment instruction</a>
        {i.executedOn ? <a className="ml-3 underline" href={`/api/asset-finance/loans/${loanId}/surplus-instructions/${i.id}/execution`}>View bank execution evidence</a> : <form className="flex flex-wrap gap-2" onSubmit={(e) => { const f = form(e); f.set("docType", "OTHER"); f.set("amountCents", String(Math.round(Number(f.get("amount")) * 100))); void post(`/api/asset-finance/loans/${loanId}/surplus-instructions/${i.id}/execution`, f) }}>
          <input type="hidden" name="destinationAccountId" value={i.accountId ?? ""} />
          <label className="w-full"><input name="destinationConfirmed" type="checkbox" value="true" required /> I checked the bank proof: this exact amount reached the destination account on the downloaded instruction.</label>
          <p className="w-full">Record an already executed bank payment. This form does not send a bank transfer.</p>
          <label>Bank execution date <input className={field} name="executedOn" type="date" required /></label>
          <label>Unique bank transaction reference <input className={field} name="bankReference" minLength={6} maxLength={200} required /></label>
          <label>Exact amount paid (R) <input className={field} name="amount" type="number" min="0.01" step="0.01" required /></label>
          <label>Bank proof of execution <input name="file" type="file" accept="application/pdf,image/*" required /></label>
          <button className={button} disabled={busy}>Record bank execution evidence</button>
        </form>}
      </>}
    </div>)}
    {instructions.filter(i => i.executedOn).map(i => <p key={`confirmation-${i.id}`}><a className="underline" href={`/api/asset-finance/loans/${loanId}/surplus-instructions/${i.id}/confirmation`}>Supplemental remittance confirmation (available after final account statement)</a></p>)}
    {surrenders.map((s) => <p key={s.id}>Surrender {s.id}: {s.status.replaceAll("_", " ")} · <a className="underline" href={`/api/asset-finance/surrenders/${s.id}/documents/valuation`}>Valuation notice</a> · <a className="underline" href={`/api/asset-finance/surrenders/${s.id}/documents/final`}>Final notice</a></p>)}
  </section>
}
