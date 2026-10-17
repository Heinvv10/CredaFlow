"use client"

import { useState } from "react"
import { OperatorSignOut } from "./OperatorSignOut"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Setup = { secret: string; otpauth: string }

/**
 * First TOTP enrolment for an operator user (/api/operator/totp). The secret
 * is shown for manual entry and as an otpauth link; it is never sent to a
 * third-party QR service. Enrolling ends the session: the user signs in again
 * with a code, which is the only session the console accepts.
 */
export function OperatorTotpEnrol({ email }: { email: string }) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  async function start() {
    setLoading(true)
    setError(null)
    const res = await fetch("/api/operator/totp").catch(() => null)
    if (res?.ok) setSetup((await res.json()) as Setup)
    else setError("Could not start set-up. Try again.")
    setLoading(false)
  }

  async function verify() {
    if (!setup) return
    setLoading(true)
    setError(null)
    const res = await fetch("/api/operator/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: setup.secret, code }),
    }).catch(() => null)
    if (res?.ok) setDone(true)
    else setError(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Verification failed")
    setLoading(false)
  }

  if (done) {
    return (
      <div className="mt-4 space-y-3">
        <p className="text-sm text-[var(--cf-text)]">
          Two-factor authentication is on. Sign in again with the next code from your authenticator app — the one you just used won&apos;t work twice.
        </p>
        <OperatorSignOut label="Sign in again" variant="default" />
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-4 text-sm text-[var(--cf-text-secondary)]">
      <p>The operator console requires an authenticator app (Google Authenticator, Authy, 1Password…) for {email}.</p>
      {!setup ? (
        <Button onClick={start} disabled={loading}>{loading ? "Starting…" : "Set up two-factor authentication"}</Button>
      ) : (
        <>
          <div>
            <p className="mb-1">Add this key to your authenticator app:</p>
            <code className="block break-all rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] p-3 font-mono text-[var(--cf-text)]">{setup.secret}</code>
            <a href={setup.otpauth} className="mt-1 inline-block text-[var(--cf-brand-alt)] hover:underline">Open in an authenticator app on this device</a>
          </div>
          <div>
            <label htmlFor="operator-totp-code" className="mb-1 block font-medium">Enter the 6-digit code it shows</label>
            <Input
              id="operator-totp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <Button onClick={verify} disabled={loading || code.length !== 6}>{loading ? "Verifying…" : "Verify and turn on"}</Button>
        </>
      )}
      {error ? <p role="alert" className="text-[var(--cf-danger)]">{error}</p> : null}
    </div>
  )
}
