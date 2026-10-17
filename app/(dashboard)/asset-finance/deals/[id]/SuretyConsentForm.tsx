"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

export function SuretyConsentForm({ dealId, signerId, documents, maritalRegime }: { dealId: string; signerId: string; maritalRegime: string; documents: { id: string; fileName: string; docType: string }[] }) {
  const router = useRouter()
  const [regime, setRegime] = useState(maritalRegime)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const field = "rounded border border-[var(--cf-border-subtle)] bg-[var(--cf-bg)] p-2 text-sm"
  return <form className="my-3 flex flex-col gap-2" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("")
    const data = new FormData(event.currentTarget)
    try {
      const response = await fetch(`/api/asset-finance/deals/${dealId}/sureties/${signerId}/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) })
      const result = await response.json()
      if (!response.ok) setError(result.error ?? "Could not record consent")
      else router.refresh()
    } catch { setError("Could not record consent") } finally { setBusy(false) }
  }}>
    <label>Marital regime <select className={field} name="maritalRegime" value={regime} onChange={(event) => setRegime(event.target.value)}>
      <option value="UNKNOWN">Unknown — blocks payout</option><option value="UNMARRIED">Unmarried</option><option value="OUT_OF_COMMUNITY">Out of community of property</option><option value="IN_COMMUNITY">In community of property</option>
    </select></label>
    {regime === "IN_COMMUNITY" && <>
      <p className="text-sm">Verify the spouse signed the wet-ink consent in the presence of two competent witnesses who also signed. Upload the scan as a Legal document below.</p>
      <label>Actual date surety signed the wet-ink suretyship <input className={field} type="date" name="suretySignedOn" /></label>
      <label>Actual date spouse signed the witnessed consent <input className={field} type="date" name="consentSignedOn" /></label>
      <label className="text-sm"><input type="checkbox" name="consentBeforeSurety" /> I verified the witnessed spouse consent was obtained before the surety signed, including the order of signatures on the same day. Later consent cannot ratify an existing suretyship.</label>
      <input className={field} name="spouseName" placeholder="Spouse full name" maxLength={200} />
      <input className={field} name="witnessOne" placeholder="First witness full name" maxLength={200} />
      <input className={field} name="witnessTwo" placeholder="Second witness full name" maxLength={200} />
      <select className={field} name="evidenceDocumentId"><option value="">Consent not yet received — blocks payout</option>{documents.filter((d) => d.docType === "LEGAL_DOCUMENT").map((d) => <option value={d.id} key={d.id}>{d.fileName}</option>)}</select>
    </>}
    <button className="self-start rounded bg-[var(--cf-brand)] px-3 py-2 text-sm text-[var(--cf-on-brand)]" disabled={busy}>{busy ? "Recording…" : "Verify and record marital regime / consent"}</button>
    {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
  </form>
}
