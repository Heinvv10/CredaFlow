"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/ThemeToggle"
import { DemoCodeNotice, demoCodeFrom } from "@/components/demo/DemoCodeNotice"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { Mail, ArrowLeft, CheckCircle, KeyRound } from "lucide-react"

// Client-facing self-service password reset. A locked-out portal
// client previously had no route back in except a dead support mailbox. This
// wires the UI to the existing OTP endpoints:
//   POST /api/portal/forgot-password  { email }                 -> emails a 6-digit code
//   POST /api/portal/reset-password   { email, otp, password, confirmPassword }
// The forgot endpoint always returns success (no account enumeration), so the
// UI always advances to the code-entry step.
/** `brandName` is `getLenderBrandName` of the resolved tenant. */
export default function PortalForgotPasswordForm({ brandName }: { brandName: string }) {
  const [step, setStep] = useState<"request" | "reset" | "done">("request")
  const [email, setEmail] = useState("")
  const [otp, setOtp] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  // Set only by a DEMO_MODE deployment's response (demoCodeReveal).
  const [demoCode, setDemoCode] = useState("")

  async function requestCode(e: React.FormEvent) {
    e.preventDefault()
    if (!turnstileToken) {
      setError("Please complete the verification challenge before submitting.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/portal/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken }),
      })
      if (res.ok) {
        setDemoCode(demoCodeFrom(await res.json()))
        setTurnstileToken(null)
        setStep("reset")
      } else {
        const d = (await res.json()) as { error?: string }
        setError(d.error ?? "Something went wrong. Please try again.")
      }
    } catch {
      setError("Network error — please try again.")
    }
    setLoading(false)
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/portal/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp, password, confirmPassword }),
      })
      if (res.ok) {
        setStep("done")
      } else {
        const d = (await res.json()) as { error?: string }
        setError(d.error ?? "Could not reset your password. Please try again.")
      }
    } catch {
      setError("Network error — please try again.")
    }
    setLoading(false)
  }

  return (
    <div className="cf-app-surface flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="fixed right-4 top-[calc(1rem+var(--cf-demo-banner-h))] z-10" />
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">{brandName}</h1>
          <p className="mt-1 text-sm text-[var(--cf-text-muted)]">Client Portal</p>
        </div>

        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8 shadow-2xl shadow-black/30">
          {error && (
            <div className="mb-4 rounded-lg border border-[rgba(208,92,75,0.35)] bg-[rgba(208,92,75,0.12)] px-4 py-3 text-sm text-[var(--cf-text)]">
              {error}
            </div>
          )}

          {step === "request" && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-bold text-[var(--cf-text)]">Reset your password</h2>
                <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">
                  Enter the email on your account and we&apos;ll send you a 6-digit reset code.
                </p>
              </div>
              <form onSubmit={requestCode} className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--cf-text-muted)]" />
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your.email@example.com"
                      required
                      disabled={loading}
                      className="pl-9 border-[var(--cf-border-strong)] focus:ring-[var(--cf-brand)]"
                    />
                  </div>
                </div>
                <TurnstileWidget
                  onToken={setTurnstileToken}
                  onError={() => setTurnstileToken(null)}
                  onExpired={() => setTurnstileToken(null)}
                />
                <Button
                  type="submit"
                  disabled={loading || !email || !turnstileToken}
                  className="w-full bg-[var(--cf-brand)] py-2.5 font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]"
                >
                  {loading ? "Sending…" : "Send reset code"}
                </Button>
              </form>
            </>
          )}

          {step === "reset" && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-bold text-[var(--cf-text)]">Enter your reset code</h2>
                <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">
                  If an account exists for <strong>{email}</strong>, we&apos;ve emailed a 6-digit code. Enter it below
                  with your new password. The code expires in 15 minutes.
                </p>
              </div>
              <form onSubmit={resetPassword} className="space-y-4">
                {demoCode && <DemoCodeNotice code={demoCode} />}
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Reset code</label>
                  <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--cf-text-muted)]" />
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                      placeholder="123456"
                      required
                      disabled={loading}
                      className="pl-9 border-[var(--cf-border-strong)] tracking-widest focus:ring-[var(--cf-brand)]"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">New password</label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    required
                    disabled={loading}
                    className="border-[var(--cf-border-strong)] focus:ring-[var(--cf-brand)]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Confirm new password</label>
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your new password"
                    required
                    disabled={loading}
                    className="border-[var(--cf-border-strong)] focus:ring-[var(--cf-brand)]"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={loading || otp.length !== 6 || !password || !confirmPassword}
                  className="w-full bg-[var(--cf-brand)] py-2.5 font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]"
                >
                  {loading ? "Resetting…" : "Reset password"}
                </Button>
                <button
                  type="button"
                  onClick={() => { setStep("request"); setOtp(""); setError("") }}
                  className="w-full text-center text-sm text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
                >
                  Didn&apos;t get a code? Start over
                </button>
              </form>
            </>
          )}

          {step === "done" && (
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
                <CheckCircle className="h-7 w-7 text-[var(--cf-success)]" />
              </div>
              <h2 className="mb-2 text-lg font-bold text-[var(--cf-text)]">Password reset</h2>
              <p className="mb-6 text-sm leading-relaxed text-[var(--cf-text-secondary)]">
                Your password has been updated. You can now sign in with your new password.
              </p>
              <Link href="/portal/login" className="text-sm font-semibold text-[var(--cf-brand-alt)] hover:underline">
                Go to sign in →
              </Link>
            </div>
          )}

          {step !== "done" && (
            <div className="mt-4 text-center">
              <Link
                href="/portal/login"
                className="flex items-center justify-center gap-1 text-sm text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
