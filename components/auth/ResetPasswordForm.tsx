"use client"

import { useState, useEffect, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/ThemeToggle"
import { CheckCircle, XCircle, Eye, EyeOff } from "lucide-react"

type ResetFormProps = {
  brandName: string
  /** Where "go to login" leads; the operator console has its own sign-in page. */
  loginHref?: string
  /** Where to ask for a new link; null where there is no self-service reset (operator users). */
  requestNewHref?: string | null
}

function ResetForm({ brandName, loginHref = "/login", requestNewHref = "/forgot-password" }: ResetFormProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get("token") ?? ""

  const [state, setState] = useState<"validating" | "valid" | "invalid" | "success">("validating")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!token) { Promise.resolve().then(() => setState("invalid")); return }
    fetch(`/api/auth/reset-password?token=${token}`)
      .then(r => r.json())
      .then((d: { valid: boolean; name?: string }) => {
        if (d.valid) { setState("valid"); setName(d.name ?? "") }
        else setState("invalid")
      })
      .catch(() => setState("invalid"))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError("Passwords do not match"); return }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return }
    setLoading(true); setError("")
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const d = await res.json() as { ok?: boolean; error?: string }
      if (d.ok) {
        setState("success")
        setTimeout(() => router.push(loginHref), 3000)
      } else {
        setError(d.error ?? "Something went wrong")
      }
    } catch {
      setError("Network error — please try again")
    }
    setLoading(false)
  }

  const strength = password.length === 0 ? 0
    : password.length < 8 ? 1
    : password.length < 12 && !/[A-Z]/.test(password) ? 2
    : password.length >= 12 && /[A-Z]/.test(password) && /[0-9]/.test(password) ? 4 : 3

  const strengthColors = ["bg-gray-100", "bg-red-400", "bg-amber-400", "bg-yellow-400", "bg-green-500"]
  const strengthLabels = ["", "Weak", "Fair", "Good", "Strong"]

  return (
    <div className="cf-app-surface min-h-screen flex items-center justify-center px-4">
      <ThemeToggle className="fixed right-4 top-[calc(1rem+var(--cf-demo-banner-h))] z-10" />
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">{brandName}</h1>
          <p className="text-[var(--cf-text-muted)] text-sm mt-1">Staff Workspace</p>
        </div>

        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8 shadow-2xl shadow-black/30">
          {state === "validating" && (
            <div className="text-center py-8 text-gray-400 text-sm">Validating reset link…</div>
          )}

          {state === "invalid" && (
            <div className="text-center">
              <div className="w-14 h-14 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <XCircle className="h-7 w-7 text-red-500" />
              </div>
              <h2 className="text-lg font-bold text-gray-900 mb-2">Link expired or invalid</h2>
              <p className="text-sm text-gray-500 mb-6">This reset link has expired or has already been used. Please request a new one.</p>
              {requestNewHref ? (
                <Link href={requestNewHref} className="inline-block px-5 py-2 bg-[var(--cf-brand)] text-[var(--cf-on-brand)] rounded-lg text-sm font-semibold hover:bg-[var(--cf-brand-alt)]">
                  Request New Link
                </Link>
              ) : null}
            </div>
          )}

          {state === "valid" && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-bold text-gray-900">Set new password</h2>
                {name && <p className="text-sm text-gray-500 mt-1">Hi {name} — choose a strong password below.</p>}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm text-red-700">{error}</div>
              )}

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">New password</label>
                  <div className="relative">
                    <Input
                      type={showPw ? "text" : "password"}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Min. 8 characters"
                      required
                      disabled={loading}
                      className="pr-10 border-gray-200"
                    />
                    <button type="button" onClick={() => setShowPw(!showPw)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                      {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {password && (
                    <div className="mt-2">
                      <div className="flex gap-1">
                        {[1,2,3,4].map(i => (
                          <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= strength ? strengthColors[strength] : "bg-gray-100"}`} />
                        ))}
                      </div>
                      {strength > 0 && <p className={`text-xs mt-1 ${strength <= 1 ? "text-red-500" : strength === 2 ? "text-amber-500" : "text-green-600"}`}>{strengthLabels[strength]}</p>}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
                  <Input
                    type={showPw ? "text" : "password"}
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    placeholder="Repeat new password"
                    required
                    disabled={loading}
                    className={`border-gray-200 ${confirm && password !== confirm ? "border-red-300 focus:ring-red-200" : ""}`}
                  />
                  {confirm && password !== confirm && (
                    <p className="text-xs text-red-500 mt-1">Passwords don&apos;t match</p>
                  )}
                </div>

                <Button
                  type="submit"
                  disabled={loading || !password || !confirm || password !== confirm}
                  className="w-full bg-[var(--cf-brand)] hover:bg-[var(--cf-brand-alt)] text-[var(--cf-on-brand)] font-semibold py-2.5"
                >
                  {loading ? "Saving…" : "Set New Password"}
                </Button>
              </form>
            </>
          )}

          {state === "success" && (
            <div className="text-center">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="h-7 w-7 text-green-600" />
              </div>
              <h2 className="text-lg font-bold text-gray-900 mb-2">Password updated!</h2>
              <p className="text-sm text-gray-500 mb-4">Your password has been changed. Redirecting you to login…</p>
              <Link href={loginHref} className="text-sm text-[var(--cf-brand-alt)] font-semibold hover:underline">Go to login now →</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** `brandName` is `getLenderBrandName` of the resolved tenant. */
export default function ResetPasswordForm(props: ResetFormProps) {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">Loading…</div>}><ResetForm {...props} /></Suspense>
}
