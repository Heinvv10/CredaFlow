"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { passwordPolicyError } from "@/lib/security/password-policy"

/** The one-time link's form: the token from the URL and a new password (POST /api/dealer/set-password). */
function SetPasswordForm({ brandName }: { brandName: string }) {
  const token = useSearchParams().get("token") ?? ""
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(token ? null : "This link is invalid. Ask for a new one.")
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) return setError("The passwords do not match")
    const weak = passwordPolicyError(password)
    if (weak) return setError(weak)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/dealer/set-password", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) setDone(true)
      else setError(body.error ?? `The password could not be set (${res.status})`)
    } catch {
      setError("Network error. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cf-app-surface flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--cf-brand)]">{brandName}</p>
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">Dealer portal</h1>
          <p className="mt-1 text-sm text-[var(--cf-text-muted)]">Set your password</p>
        </div>
        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8">
          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-[var(--cf-text)]">Your password is set. Sign in with your email address and the new password.</p>
              <Link href="/dealer/login" className="inline-block rounded-md bg-[var(--cf-brand)] px-5 py-2 text-sm font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]">
                Sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error ? <p role="alert" className="rounded-md border border-[var(--cf-danger)] px-3 py-2 text-sm text-[var(--cf-danger)]">{error}</p> : null}
              <div className="space-y-1.5">
                <Label htmlFor="dealer-new-password" className="text-xs text-[var(--cf-text-secondary)]">New password</Label>
                <Input id="dealer-new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dealer-confirm-password" className="text-xs text-[var(--cf-text-secondary)]">Confirm the password</Label>
                <Input id="dealer-confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={saving || !token || !password || !confirm}>
                {saving ? "Saving…" : "Set password"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export function DealerSetPasswordForm(props: { brandName: string }) {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-sm text-[var(--cf-text-muted)]">Loading…</div>}>
      <SetPasswordForm {...props} />
    </Suspense>
  )
}
