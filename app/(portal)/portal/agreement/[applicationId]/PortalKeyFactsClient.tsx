"use client"

import { useState } from "react"
import { CheckCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { SigningOtpStep, type SigningOtpChannel } from "@/components/signing/SigningOtpStep"
import { LOAN_DOCUMENT_LABELS, SAMPLE_BANNER_TEXT } from "@/lib/non-nca-documents/keys"

interface DocRef {
  documentId: string
  sha256: string
  templateVersion: number
  sample: boolean
}

interface Props {
  applicationId: string
  reference: string
  clientName: string
  keyFacts: DocRef & { acknowledged: boolean }
  agreement: DocRef
  signingOtp: { required: boolean; channels: SigningOtpChannel[] }
}

/**
 * The borrower's side of a key-facts (non-NCA) application: read and acknowledge the
 * key facts statement, then read and sign the loan agreement. Both documents are
 * the lender's own, rendered from its approved templates; the digest of each is
 * echoed so nothing is acknowledged or signed over bytes the borrower did not see.
 */
export function PortalKeyFactsClient({ applicationId, reference, clientName, keyFacts, agreement, signingOtp }: Props) {
  const [read, setRead] = useState(false)
  const [acknowledged, setAcknowledged] = useState(keyFacts.acknowledged)
  const [busy, setBusy] = useState<"ack" | "sign" | null>(null)
  const [typedName, setTypedName] = useState("")
  const [otpChallengeId, setOtpChallengeId] = useState<string | null>(null)
  const [otpAttempt, setOtpAttempt] = useState(0)
  const [signed, setSigned] = useState(false)
  const otpSatisfied = !signingOtp.required || otpChallengeId !== null

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/applications/${applicationId}/loan-documents/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as { error?: string; signingOtp?: string }
    return { ok: res.ok, data }
  }

  async function acknowledge() {
    setBusy("ack")
    try {
      const { ok, data } = await post("acknowledge", { documentSha256: keyFacts.sha256 })
      if (ok) setAcknowledged(true)
      else toast.error?.("Could not record your acknowledgement", data.error ?? "Try again")
    } catch {
      toast.networkError?.()
    } finally {
      setBusy(null)
    }
  }

  async function sign() {
    setBusy("sign")
    try {
      const { ok, data } = await post("sign", {
        agreementDocumentSha256: agreement.sha256, signature: typedName.trim(), ...(otpChallengeId ? { signingOtpChallengeId: otpChallengeId } : {}),
      })
      if (ok) setSigned(true)
      else {
        if (data.signingOtp) { setOtpChallengeId(null); setOtpAttempt((n) => n + 1) }
        toast.error?.("Could not sign", data.error ?? "Try again")
      }
    } catch {
      toast.networkError?.()
    } finally {
      setBusy(null)
    }
  }

  if (signed) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12 text-center" data-testid="key-facts-signed">
        <div className="rounded-lg border border-[var(--cf-success)] bg-[var(--cf-surface-soft)] p-8">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-[var(--cf-success)]" />
          <p className="mb-2 text-2xl font-bold text-[var(--cf-success)]">Loan agreement signed</p>
          <p className="text-[var(--cf-success)]">Thank you, {clientName}. The lender will now prepare your loan for payout. You can follow it under your applications.</p>
          <a className="mt-6 inline-block text-sm underline" href={`/portal/applications/${applicationId}`}>Back to your application</a>
        </div>
      </div>
    )
  }

  const sample = keyFacts.sample || agreement.sample
  const canSign = acknowledged && typedName.trim().length > 2 && otpSatisfied && busy === null

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-bold">Your loan documents</h1>
        <p className="text-sm text-[var(--cf-text-muted)]">Application {reference}</p>
        {sample && <p role="note" className="mt-2 rounded border border-[var(--cf-warning)] bg-[var(--cf-surface-soft)] p-2 text-sm font-semibold text-[var(--cf-warning)]">{SAMPLE_BANNER_TEXT}. This is a demonstration.</p>}
      </div>

      <section className="space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-4" aria-labelledby="kfs-heading">
        <h2 id="kfs-heading" className="text-lg font-semibold">1. {LOAN_DOCUMENT_LABELS.KEY_FACTS_STATEMENT}</h2>
        <iframe title="Key facts statement" src={`/api/documents/${keyFacts.documentId}/view`} className="h-[520px] w-full rounded border border-[var(--cf-border-subtle)]" />
        <a className="text-sm underline" href={`/api/documents/${keyFacts.documentId}/view`} target="_blank" rel="noreferrer">Open the key facts statement in a new tab</a>
        {acknowledged ? (
          <p className="flex items-center gap-2 text-sm text-[var(--cf-success)]"><CheckCircle className="h-4 w-4" />You have acknowledged this key facts statement.</p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="mt-1" />
              <span>I have read and understood the key facts statement above.</span>
            </label>
            <Button onClick={acknowledge} disabled={!read || busy !== null}>
              {busy === "ack" ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving</> : "Acknowledge key facts statement"}
            </Button>
          </>
        )}
      </section>

      <section className={`space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-4 ${acknowledged ? "" : "opacity-60"}`} aria-labelledby="agreement-heading">
        <h2 id="agreement-heading" className="text-lg font-semibold">2. {LOAN_DOCUMENT_LABELS.LOAN_AGREEMENT}</h2>
        {acknowledged ? (
          <>
            <iframe title="Loan agreement" src={`/api/documents/${agreement.documentId}/view`} className="h-[520px] w-full rounded border" />
            <a className="text-sm underline" href={`/api/documents/${agreement.documentId}/view`} target="_blank" rel="noreferrer">Open the loan agreement in a new tab</a>
            <label className="block text-sm">
              Type your full name to sign
              <input
                type="text" value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={clientName}
                className="mt-1 w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 font-['Georgia'] text-xl italic text-[var(--cf-text)] focus:outline-none focus:ring-2 focus:ring-[var(--cf-brand)]"
              />
            </label>
            {signingOtp.required && (
              <SigningOtpStep
                key={otpAttempt} purpose="AGREEMENT" subjectId={applicationId} documentSha256={agreement.sha256}
                channels={signingOtp.channels} onVerified={setOtpChallengeId}
              />
            )}
            <Button onClick={sign} disabled={!canSign} className="w-full py-6 text-lg">
              {busy === "sign" ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Signing</> : <><CheckCircle className="mr-2 h-5 w-5" />I accept and sign</>}
            </Button>
          </>
        ) : (
          <p className="text-sm text-[var(--cf-text-secondary)]">Acknowledge the key facts statement first; the loan agreement is shown after.</p>
        )}
      </section>
    </div>
  )
}
