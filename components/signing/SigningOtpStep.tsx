"use client"

import { useState } from "react"
import { CheckCircle, Loader2, ShieldCheck } from "lucide-react"
import { DemoCodeNotice, demoCodeFrom } from "@/components/demo/DemoCodeNotice"

export type SigningOtpChannel = "EMAIL" | "WHATSAPP"

const CHANNEL_LABEL: Record<SigningOtpChannel, string> = { EMAIL: "email", WHATSAPP: "WhatsApp" }

type Issued = { challengeId: string; channel: SigningOtpChannel; maskedDestination: string }

/**
 * The one-time-code step before a signature (lib/signing-otp). Requests a
 * code for the exact bytes on screen (`documentSha256`), verifies it, and
 * hands the verified challenge id to the signing form, which sends it with
 * the signature. The code itself never leaves this component except to the
 * verify endpoint.
 */
export function SigningOtpStep({
  purpose,
  subjectId,
  documentSha256,
  channels,
  onVerified,
}: {
  purpose: "AGREEMENT" | "DEBIT_MANDATE" | "DOCUMENT" | "DEAL_DOCUMENT"
  subjectId: string
  documentSha256: string | null
  channels: SigningOtpChannel[]
  onVerified: (challengeId: string | null) => void
}) {
  const [issued, setIssued] = useState<Issued | null>(null)
  const [verified, setVerified] = useState(false)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [demoCode, setDemoCode] = useState("")

  async function send(channel: SigningOtpChannel) {
    setBusy(true)
    setError("")
    setVerified(false)
    onVerified(null)
    try {
      const res = await fetch("/api/signing-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, subjectId, documentSha256, channel }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "We could not send a code. Try again.")
        return
      }
      setIssued({ challengeId: data.challengeId, channel: data.channel, maskedDestination: data.maskedDestination })
      setDemoCode(demoCodeFrom(data))
      setCode("")
    } catch {
      setError("Network error. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    if (!issued) return
    setBusy(true)
    setError("")
    try {
      const res = await fetch(`/api/signing-otp/${issued.challengeId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "That code could not be verified.")
        return
      }
      setVerified(true)
      onVerified(issued.challengeId)
    } catch {
      setError("Network error. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-6 text-[var(--cf-text)]">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--cf-brand)]" />
        <div>
          <p className="font-semibold">Confirm it&rsquo;s you</p>
          <p className="text-sm text-[var(--cf-text-muted)]">
            We&rsquo;ll send a one-time code to your contact details on file. Enter it to unlock signing.
          </p>
        </div>
      </div>

      {channels.length === 0 ? (
        <p className="text-sm text-[var(--cf-danger)]">
          We have no email address or WhatsApp number on file to send a code to. Please contact us to update your details.
        </p>
      ) : verified ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--cf-success)]">
          <CheckCircle className="h-4 w-4" /> Code verified. You can sign now.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {channels.map((channel) => (
              <button
                key={channel}
                type="button"
                disabled={busy}
                onClick={() => send(channel)}
                className="rounded border border-[var(--cf-border-strong)] px-3 py-2 text-sm font-medium hover:border-[var(--cf-brand)] disabled:opacity-60"
              >
                {issued ? "Send a new code" : "Send code"} by {CHANNEL_LABEL[channel]}
              </button>
            ))}
          </div>
          {issued && (
            <form onSubmit={verify} className="space-y-3">
              <p className="text-sm text-[var(--cf-text-secondary)]">
                We sent a 6-digit code by {CHANNEL_LABEL[issued.channel]} to {issued.maskedDestination}. It expires in 5 minutes.
              </p>
              {demoCode && <DemoCodeNotice code={demoCode} />}
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-label="One-time code"
                  placeholder="123456"
                  className="w-40 rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 tracking-[0.3em] text-[var(--cf-text)] focus:border-[var(--cf-brand)] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={busy || code.length !== 6}
                  className="flex items-center gap-2 rounded bg-[var(--cf-brand)] px-4 py-2 text-sm font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)] disabled:opacity-60"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}Verify code
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
    </section>
  )
}
