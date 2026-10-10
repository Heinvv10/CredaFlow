"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react"
import { ThemeToggle } from "@/components/ThemeToggle"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { trackRegisterActivated, trackRegisterCodeSent, trackRegisterStart } from "@/lib/analytics/events"
import { safePortalPath } from "@/lib/portal-urls"

type Step = "request" | "verify"

const DEFAULT_NOTICE =
  "If those details match an application, we've emailed a 6-digit activation code. Enter it below to finish."

function PortalRegisterInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [step, setStep] = useState<Step>("request")
  const [email, setEmail] = useState(params.get("email") || "")
  const [idNumber, setIdNumber] = useState("")
  const [otp, setOtp] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  // A Turnstile token is single-use, so step 2 must acquire its own token
  // rather than resubmit the one spent on step 1's request — the widget
  // below is remounted (via a step-scoped `key`) whenever the step changes.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [activated, setActivated] = useState(false)
  const reference = params.get("reference") || ""

  // Funnel entry — fire once on mount, independent of which step is showing.
  useEffect(() => {
    trackRegisterStart()
  }, [])

  async function handleRequestCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!turnstileToken) {
      setError("Please complete the verification challenge before submitting.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/portal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, idNumber, turnstileToken }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.")
        return
      }
      trackRegisterCodeSent()
      setNotice(data.message || DEFAULT_NOTICE)
      setTurnstileToken(null)
      setStep("verify")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function handleActivate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!turnstileToken) {
      setError("Please complete the verification challenge before submitting.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/portal/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, idNumber, otp, password, confirmPassword, turnstileToken }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Could not activate the account. Please check your code and try again.")
        return
      }
      trackRegisterActivated()
      setActivated(true)
      // Carry the deep-link destination through activation. A customer who
      // arrived from "sign your agreement" must land on that agreement, not on
      // a list they then have to navigate. safePortalPath rejects anything that
      // is not a same-origin portal path — this value is caller-supplied.
      const destination = safePortalPath(params.get("next")) ?? "/portal/applications"
      setTimeout(
        () => router.push(`/portal/login?callbackUrl=${encodeURIComponent(destination)}`),
        900,
      )
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="cf-app-surface min-h-screen px-4 py-14 text-[var(--cf-text)]">
      <ThemeToggle className="fixed right-4 top-4 z-10" />
      <div className="mx-auto w-full max-w-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-7 shadow-[var(--cf-shadow-panel)] backdrop-blur-xl">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[var(--cf-brand)]">Client portal</p>
        <h1 className="text-3xl font-semibold">Activate your portal account</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--cf-text-muted)]">
          Your portal account is created from a loan application you&rsquo;ve already submitted. Enter the same
          email address and SA ID number from that application so we can link your portal profile.
        </p>
        {reference && (
          <div className="mt-5 border border-[var(--cf-border-strong)] bg-[color-mix(in_srgb,var(--cf-brand)_8%,transparent)] px-4 py-3 text-sm text-[var(--cf-brand)]">
            Application reference: <strong>{reference}</strong>
          </div>
        )}

        {activated ? (
          <div className="mt-6 border border-green-400/30 bg-green-400/10 px-4 py-4 text-sm text-[var(--cf-success)]">
            <div className="flex items-start gap-3">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <p>Account activated. Redirecting you to the portal login...</p>
            </div>
          </div>
        ) : step === "request" ? (
          <form onSubmit={handleRequestCode} className="mt-6 space-y-4">
            {error && (
              <div className="flex gap-3 border border-[rgba(208,92,75,0.35)] bg-[rgba(208,92,75,0.12)] px-4 py-3 text-sm text-[var(--cf-danger)]">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
            <label className="block text-sm font-semibold text-[var(--cf-text-secondary)]">
              Email address
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-2 w-full border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)] outline-none transition focus:border-[var(--cf-brand)]"
                required
              />
            </label>
            <label className="block text-sm font-semibold text-[var(--cf-text-secondary)]">
              SA ID number
              <input
                value={idNumber}
                onChange={(e) => setIdNumber(e.target.value)}
                className="mt-2 w-full border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)] outline-none transition focus:border-[var(--cf-brand)]"
                maxLength={13}
                inputMode="numeric"
                required
              />
            </label>
            <TurnstileWidget
              key="step-request"
              onToken={setTurnstileToken}
              onError={() => setTurnstileToken(null)}
              onExpired={() => setTurnstileToken(null)}
            />
            <button
              type="submit"
              disabled={loading || !turnstileToken}
              className="flex w-full items-center justify-center gap-2 bg-[var(--cf-brand)] px-5 py-3 text-sm font-bold text-[var(--cf-on-brand)] transition hover:bg-[var(--cf-brand-alt)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Send activation code
            </button>
          </form>
        ) : (
          <form onSubmit={handleActivate} className="mt-6 space-y-4">
            {notice && (
              <div className="border border-[var(--cf-border-strong)] bg-[color-mix(in_srgb,var(--cf-brand)_8%,transparent)] px-4 py-3 text-sm text-[var(--cf-brand)]">
                {notice}
              </div>
            )}
            {error && (
              <div className="flex gap-3 border border-[rgba(208,92,75,0.35)] bg-[rgba(208,92,75,0.12)] px-4 py-3 text-sm text-[var(--cf-danger)]">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
            <label className="block text-sm font-semibold text-[var(--cf-text-secondary)]">
              6-digit activation code
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="mt-2 w-full border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)] outline-none transition focus:border-[var(--cf-brand)]"
                maxLength={6}
                inputMode="numeric"
                required
              />
            </label>
            <label className="block text-sm font-semibold text-[var(--cf-text-secondary)]">
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-2 w-full border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)] outline-none transition focus:border-[var(--cf-brand)]"
                minLength={8}
                required
              />
            </label>
            <label className="block text-sm font-semibold text-[var(--cf-text-secondary)]">
              Confirm password
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-2 w-full border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)] outline-none transition focus:border-[var(--cf-brand)]"
                minLength={8}
                required
              />
            </label>
            <TurnstileWidget
              key="step-verify"
              onToken={setTurnstileToken}
              onError={() => setTurnstileToken(null)}
              onExpired={() => setTurnstileToken(null)}
            />
            <button
              type="submit"
              disabled={loading || !turnstileToken}
              className="flex w-full items-center justify-center gap-2 bg-[var(--cf-brand)] px-5 py-3 text-sm font-bold text-[var(--cf-on-brand)] transition hover:bg-[var(--cf-brand-alt)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Activate account
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("request")
                setError("")
                setTurnstileToken(null)
              }}
              className="w-full text-center text-sm font-semibold text-[var(--cf-text-muted)] underline"
            >
              Back to edit details
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-[var(--cf-text-muted)]">
          Already have an account?{" "}
          <Link href="/portal/login?callbackUrl=%2Fportal%2Fapplications" className="font-semibold text-[var(--cf-brand)] underline">
            Log in to track your application
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-[var(--cf-text-muted)]">
          Haven&rsquo;t applied yet?{" "}
          <Link href="/site/apply" className="font-semibold text-[var(--cf-brand)] underline">
            Start an application
          </Link>
        </p>
      </div>
    </main>
  )
}

export default function PortalRegisterForm() {
  return (
    <Suspense fallback={null}>
      <PortalRegisterInner />
    </Suspense>
  )
}
