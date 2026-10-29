"use client"

import { useEffect, useRef, useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { accessRefusalMessage } from "@/lib/security/staff-access-messages"

/** The "Sign in with single sign-on" entry on the staff form. */
export function SsoStartLink({ callbackUrl }: { callbackUrl: string }) {
  return (
    <a
      href={`/api/auth/sso/start?callbackUrl=${encodeURIComponent(callbackUrl)}`}
      className="block w-full rounded-md border border-[var(--cf-border-strong)] py-2.5 text-center font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-bg-raised)]"
    >
      Sign in with single sign-on
    </a>
  )
}

/**
 * After the identity provider sends the browser back: trade the ticket cookie
 * for a session, asking for an authenticator code only when one is due. The
 * ticket never reaches this script (it is an HttpOnly cookie).
 */
export function SsoReturn({ callbackUrl }: { callbackUrl: string }) {
  const router = useRouter()
  const started = useRef(false)
  const [needsCode, setNeedsCode] = useState(false)
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [working, setWorking] = useState(true)

  async function attempt(otp: string) {
    setWorking(true)
    setError("")
    const result = await signIn("sso", { code: otp, redirect: false })
    if (result?.ok && !result.error) {
      router.push(callbackUrl)
      router.refresh()
      return
    }
    const errorCode = (result as { code?: string } | undefined)?.code
    if (errorCode === "totp_required") {
      setNeedsCode(true)
    } else if (errorCode === "totp_invalid") {
      setError("Invalid verification code. Try again.")
    } else if (errorCode === "rate_limited") {
      setError("Too many attempts. Wait a few minutes and try again.")
    } else {
      setError(accessRefusalMessage(errorCode) ?? accessRefusalMessage("sso_refused") ?? "")
      setNeedsCode(false)
    }
    setWorking(false)
  }

  useEffect(() => {
    // Once: the ticket is single use, and StrictMode runs effects twice in development.
    if (started.current) return
    started.current = true
    void attempt("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      {needsCode ? (
        <form onSubmit={(e) => { e.preventDefault(); void attempt(code) }} className="space-y-4">
          <p className="text-sm text-[var(--cf-text-secondary)]">Enter the 6-digit code from your authenticator app.</p>
          <Input
            name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" disabled={working}
            aria-label="Verification code" className="border-[var(--cf-border-strong)] text-center tracking-widest"
          />
          <Button type="submit" disabled={working || code.length !== 6} className="w-full bg-[var(--cf-brand)] py-2.5 font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]">
            {working ? "Verifying…" : "Verify and sign in"}
          </Button>
        </form>
      ) : working ? (
        <p className="text-sm text-[var(--cf-text-secondary)]">Signing you in…</p>
      ) : (
        <SsoStartLink callbackUrl={callbackUrl} />
      )}
    </div>
  )
}
