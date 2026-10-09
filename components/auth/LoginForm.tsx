"use client"

import { useState, Suspense } from "react"
import { sastParts } from "@/lib/date/sast"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/ThemeToggle"
import { AlertCircle } from "lucide-react"

export type LoginVariant = "staff" | "client"

type CopyMap = {
  title: string
  subtitle: string
  emailPlaceholder: string
  fallbackDest: string
  errorWrongAudience: string
}

const COPY: Record<LoginVariant, CopyMap> = {
  staff: {
    title: "Staff Workspace",
    subtitle: "Secure workspace access",
    emailPlaceholder: "you@example.com",
    fallbackDest: "/dashboard",
    // Shown when a client email is used here — generic to avoid email enumeration.
    errorWrongAudience: "Invalid email or password",
  },
  client: {
    title: "Client Portal",
    subtitle: "Sign in to manage your loans and applications",
    emailPlaceholder: "your.email@example.com",
    fallbackDest: "/portal",
    errorWrongAudience: "Invalid email or password",
  },
}

type LoginFormProps = {
  variant?: LoginVariant
  /** `getLenderBrandName` of the resolved tenant. */
  brandName: string
  /** Link to the other audience's sign-in on its own host, or null when this
   *  deployment's host env is not configured (the link is then omitted). */
  crossLink: { href: string; label: string } | null
}

function LoginFormInner({ variant, brandName, crossLink }: Required<LoginFormProps>) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const copy = COPY[variant]
  const callbackUrl = searchParams.get("callbackUrl") || copy.fallbackDest
  const errorMsg = searchParams.get("error")

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(errorMsg || "")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [step, setStep] = useState<"password" | "totp">("password")
  const [code, setCode] = useState("")

  async function attemptSignIn(otpCode: string) {
    return signIn("credentials", {
      email,
      password,
      code: otpCode,
      loginType: variant === "staff" ? "staff" : "client",
      redirect: false,
    })
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError("")

    try {
      const result = await attemptSignIn(step === "totp" ? code : "")

      if (result?.ok && !result.error) {
        router.push(callbackUrl)
        router.refresh()
        return
      }

      // NextAuth v5 surfaces the CredentialsSignin subclass `code` here.
      const errorCode = (result as { code?: string; error?: string } | undefined)?.code

      if (errorCode === "totp_required") {
        setStep("totp")
        setError("")
      } else if (errorCode === "totp_invalid") {
        setError("Invalid verification code. Try again.")
      } else if (errorCode === "rate_limited") {
        setError("Too many sign-in attempts. Wait a few minutes and try again.")
      } else if (errorCode === "wrong_audience") {
        setError(copy.errorWrongAudience)
      } else if (step === "totp") {
        // Falling back to password step on a non-TOTP error mid-flow is jarring;
        // treat as an invalid-code retry to avoid leaking which factor failed.
        setError("Invalid verification code. Try again.")
      } else {
        setError("Invalid email or password")
      }
      setLoading(false)
    } catch {
      setError("An error occurred. Please try again.")
      setLoading(false)
    }
  }

  function handleStartOver() {
    setStep("password")
    setCode("")
    setError("")
  }

  return (
    <div className="mx-auto w-full max-w-md">
      {/* Header */}
      <div className="mb-8 text-center">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--cf-brand)]">
          {brandName}
        </p>
        <h1 className="text-3xl font-bold text-[var(--cf-text)]">{copy.title}</h1>
        <p className="mt-2 text-sm text-[var(--cf-text-secondary)]">{copy.subtitle}</p>
      </div>

      {/* Error alert */}
      {error && (
        <div className="mb-4 flex gap-3 rounded-lg border border-[rgba(208,92,75,0.35)] bg-[rgba(208,92,75,0.12)] px-4 py-3">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--cf-danger)]" />
          <p className="text-sm text-[var(--cf-text)]">{error}</p>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {step === "password" && (
          <>
            <div>
              <label htmlFor={`${variant}-login-email`} className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Email address</label>
              <Input
                id={`${variant}-login-email`}
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={copy.emailPlaceholder}
                required
                disabled={loading}
                className="border-[var(--cf-border-strong)] focus:ring-[var(--cf-brand)]"
              />
            </div>

            <div>
              <label htmlFor={`${variant}-login-password`} className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Password</label>
              <Input
                id={`${variant}-login-password`}
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                disabled={loading}
                className="border-[var(--cf-border-strong)] focus:ring-[var(--cf-brand)]"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--cf-text-muted)]">
                <input id={`${variant}-remember-me`} name="remember" type="checkbox" className="rounded border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)]" />
                Remember me
              </label>
              {/* Self-service password reset for both audiences (W-5). Staff use
                  /forgot-password (User table, token link); clients use
                  /portal/forgot-password (Client OTP flow backed by
                  /api/portal/{forgot,reset}-password). Replaces the previous dead
                  a dead mailto: link. */}
              <Link
                href={variant === "staff" ? "/forgot-password" : "/portal/forgot-password"}
                className="text-sm font-medium text-[#4338CA] hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full bg-[var(--cf-brand)] py-2.5 font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]"
            >
              {loading ? "Signing in…" : "Sign in"}
            </Button>

            {/* Cross-link to the other audience's login. Only shown on the
                password step — surfacing it on the TOTP step would let a user
                who has already passed the password check infer which audience
                they belong to and break the symmetry of "Invalid email or
                password" error responses. */}
            {crossLink ? (
              <p className="mt-2 text-center text-xs text-[var(--cf-text-muted)]">
                <Link href={crossLink.href} className="hover:text-[var(--cf-text-secondary)] hover:underline">
                  {crossLink.label}
                </Link>
              </p>
            ) : null}

            {/* First-time applicants land here from an email link; the register
                page has the reverse "Already have an account?" link, so this
                closes the login↔register loop. Client portal only — staff
                accounts aren't self-registered. */}
            {variant === "client" ? (
              <p className="mt-1 text-center text-xs text-[var(--cf-text-muted)]">
                First time here?{" "}
                <Link href="/portal/register" className="font-medium text-[#4338CA] hover:underline">
                  Create your account
                </Link>
              </p>
            ) : null}
          </>
        )}

        {step === "totp" && (
          <>
            <div className="text-sm text-[var(--cf-text-secondary)]">
              Enter the 6-digit code from your authenticator app for{" "}
              <span className="font-medium text-[var(--cf-text)]">{email}</span>.
            </div>
            <div>
              <label htmlFor={`${variant}-login-code`} className="mb-1 block text-sm font-medium text-[var(--cf-text-secondary)]">Verification code</label>
              <Input
                id={`${variant}-login-code`}
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                required
                disabled={loading}
                autoFocus
                className="border-[var(--cf-border-strong)] text-center tracking-widest focus:ring-[var(--cf-brand)]"
              />
            </div>
            <Button
              type="submit"
              disabled={loading || code.length !== 6}
              className="w-full bg-[var(--cf-brand)] py-2.5 font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]"
            >
              {loading ? "Verifying…" : "Verify and sign in"}
            </Button>
            <button
              type="button"
              onClick={handleStartOver}
              className="w-full text-center text-sm text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
            >
              Use a different account
            </button>
          </>
        )}
      </form>

      {/* Footer */}
      <p className="mt-6 text-center text-xs text-[var(--cf-text-muted)]">
        © {sastParts(new Date()).year} {brandName}. All rights reserved.
      </p>
    </div>
  )
}

export default function LoginForm({ variant = "staff", brandName, crossLink }: LoginFormProps) {
  return (
    <div className="cf-app-surface flex min-h-screen items-center justify-center px-4">
      <ThemeToggle className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-md rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8 shadow-2xl shadow-black/35">
        <Suspense fallback={<div className="text-center text-[var(--cf-text-muted)]">Loading...</div>}>
          <LoginFormInner variant={variant} brandName={brandName} crossLink={crossLink} />
        </Suspense>
      </div>
    </div>
  )
}
