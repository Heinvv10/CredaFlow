"use client"

import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Mail, ArrowLeft, CheckCircle } from "lucide-react"

/** `brandName` is `getLenderBrandName` of the resolved tenant. */
export default function ForgotPasswordForm({ brandName }: { brandName: string }) {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
      if (res.ok) {
        setSent(true)
      } else {
        const d = await res.json() as { error?: string }
        setError(d.error ?? "Something went wrong")
      }
    } catch {
      setError("Network error — please try again")
    }
    setLoading(false)
  }

  return (
    <div className="cf-app-surface min-h-screen flex items-center justify-center px-4">
      <ThemeToggle className="fixed right-4 top-4 z-10" />
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">{brandName}</h1>
          <p className="text-[var(--cf-text-muted)] text-sm mt-1">Staff Workspace</p>
        </div>

        <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8 shadow-2xl shadow-black/30">
          {sent ? (
            <div className="text-center">
              <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle className="h-7 w-7 text-[var(--cf-success)]" />
              </div>
              <h2 className="text-lg font-bold text-[var(--cf-text)] mb-2">Check your email</h2>
              <p className="text-sm text-[var(--cf-text-secondary)] mb-6 leading-relaxed">
                If an account with <strong>{email}</strong> exists, we&apos;ve sent a password reset link.
                The link expires in 30 minutes.
              </p>
              <p className="text-xs text-[var(--cf-text-muted)] mb-4">Didn&apos;t get it? Check your spam folder.</p>
              <Link href="/login" className="text-sm text-[var(--cf-brand-alt)] font-semibold hover:underline">
                ← Back to login
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-bold text-[var(--cf-text)]">Forgot your password?</h2>
                <p className="text-sm text-[var(--cf-text-secondary)] mt-1">Enter your email and we&apos;ll send a reset link.</p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4 text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--cf-text-secondary)] mb-1">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-300" />
                    <Input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      disabled={loading}
                      className="pl-9 border-gray-200"
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading || !email}
                  className="w-full bg-[var(--cf-brand)] hover:bg-[var(--cf-brand-alt)] text-[var(--cf-on-brand)] font-semibold py-2.5"
                >
                  {loading ? "Sending…" : "Send Reset Link"}
                </Button>
              </form>

              <div className="mt-4 text-center">
                <Link href="/login" className="text-sm text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] flex items-center justify-center gap-1">
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to login
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
