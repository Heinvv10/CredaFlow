"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SignaturePad } from "@/components/asset-finance/SignaturePad"
import { useT } from "@/lib/i18n/client"
import { SigningOtpStep, type SigningOtpChannel } from "@/components/signing/SigningOtpStep"

const NO_SIGNING_OTP = { required: false, channels: [] as SigningOtpChannel[] }

/**
 * Read-confirmation, signature, the signing code when the lender requires one
 * (lib/signing-otp), and submit for one deal document.
 */
export function DealSignClient(props: {
  signerId: string
  documentSha256: string
  documentLabel: string
  signingOtp?: { required: boolean; channels: SigningOtpChannel[] }
}) {
  const t = useT("portalSigning")
  const signingOtp = props.signingOtp ?? NO_SIGNING_OTP
  const router = useRouter()
  const [read, setRead] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null)
  // Remounts the code step after a refusal that spent or voided the code.
  const [otpAttempt, setOtpAttempt] = useState(0)
  const otpSatisfied = !signingOtp.required || otpChallengeId !== null

  async function submit() {
    if (!read || !signature || !otpSatisfied) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/portal/asset-finance/deal-signers/${props.signerId}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signature,
          documentSha256: props.documentSha256,
          ...(otpChallengeId ? { signingOtpChallengeId: otpChallengeId } : {}),
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; signingOtp?: string }
        if (data.signingOtp) {
          setOtpChallengeId(null)
          setOtpAttempt((n) => n + 1)
        }
        setError(data.error ?? t("dealErrSign"))
        return
      }
      router.refresh()
    } catch {
      setError(t("dealErrNetwork"))
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
      {signingOtp.required && (
        <SigningOtpStep
          key={otpAttempt}
          purpose="DEAL_DOCUMENT"
          subjectId={props.signerId}
          documentSha256={props.documentSha256}
          channels={signingOtp.channels}
          onVerified={setOtpChallengeId}
        />
      )}
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <Button type="button" className="w-full" disabled={!read || !signature || !otpSatisfied || busy} onClick={submit}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
        {busy ? t("dealSigning") : "Sign electronically"}
      </Button>
    </div>
  )
}
