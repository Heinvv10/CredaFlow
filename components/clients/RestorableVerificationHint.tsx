"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { documentActionFailureMessage } from "@/lib/documents/verify-failure"
import { VERIFICATION_RESTORABLE_COPY } from "@/lib/kyc/verification-restorable"

interface Props {
  clientId: string
  /** The newest verified ID copy (newestVerifiedIdCopyId); null while the list loads. */
  idDocumentId: string | null
  /** The stored KYC status the verify route reports back. */
  onRestored: (kycStatus: string) => void
}

/**
 * The stored status is PENDING while the evidence derives VERIFIED. "Re-verify
 * ID" sends the newest verified ID copy through the existing verify route
 * (verified: true), so its role check, TOTP-gated session, evidence lock,
 * composite re-derivation and audit row all apply unchanged. Refusals stay on
 * screen next to the button instead of in a toast.
 */
export function RestorableVerificationHint({ clientId, idDocumentId, onRestored }: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reverify() {
    if (!idDocumentId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/documents/${idDocumentId}/verify`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verified: true }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        setError(documentActionFailureMessage(body, "Could not re-verify the ID copy."))
        return
      }
      const kycStatus = (body as { kycStatus?: unknown } | null)?.kycStatus
      if (typeof kycStatus === "string") onRestored(kycStatus)
      if (kycStatus !== "VERIFIED") {
        setError(`The ID copy is verified, but KYC is still ${typeof kycStatus === "string" ? kycStatus : "not VERIFIED"}.`)
      }
      router.refresh()
    } catch {
      setError("Could not reach the server. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-4 text-sm text-[var(--cf-warning)]">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 space-y-2">
        <p>{VERIFICATION_RESTORABLE_COPY}</p>
        {error && <p role="alert" className="text-[var(--cf-danger)]">{error}</p>}
      </div>
      {idDocumentId && (
        <Button size="sm" variant="outline" onClick={reverify} disabled={submitting}>
          {submitting
            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            : <ShieldCheck className="mr-1 h-3 w-3" />}
          Re-verify ID
        </Button>
      )}
    </div>
  )
}
