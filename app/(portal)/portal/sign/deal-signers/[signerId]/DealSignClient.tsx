"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SignaturePad } from "@/components/asset-finance/SignaturePad"

/** Read-confirmation, signature and submit for one deal document. */
export function DealSignClient(props: { signerId: string; documentSha256: string; documentLabel: string }) {
  const router = useRouter()
  const [read, setRead] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!read || !signature) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/asset-finance/deal-signers/${props.signerId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature, documentSha256: props.documentSha256 }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? "Signing failed; please try again")
        return
      }
      router.refresh()
    } catch {
      setError("We could not reach the server; check your connection and try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-5">
      <label className="flex items-start gap-3 text-sm text-[var(--cf-text)]">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="mt-1 h-4 w-4" />
        I have read the {props.documentLabel.toLowerCase()} above and I am signing it electronically.
      </label>
      <SignaturePad onChange={setSignature} />
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <Button type="button" className="w-full" disabled={!read || !signature || busy} onClick={submit}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
        {busy ? "Signing…" : "Sign electronically"}
      </Button>
    </div>
  )
}
