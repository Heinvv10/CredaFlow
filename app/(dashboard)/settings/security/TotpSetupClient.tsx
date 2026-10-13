"use client"

import { useState } from "react"
import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Shield, ShieldCheck, ShieldOff, Loader2, Copy, CheckCircle } from "lucide-react"

interface Props {
  email: string
  totpEnabled: boolean
  /** The lender requires staff 2FA: it cannot be turned off. */
  required: boolean
  /** This session is held at enrolment until 2FA is set up. */
  enrolmentForced: boolean
}

interface SetupData {
  secret: string
  otpauth: string
  qrUrl: string
}

export function TotpSetupClient({ email, totpEnabled, required, enrolmentForced }: Props) {
  const [enabled, setEnabled] = useState(totpEnabled)
  const [setup, setSetup] = useState<SetupData | null>(null)
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [signInAgain, setSignInAgain] = useState(false)

  const startSetup = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/totp")
      const data = await res.json() as { secret: string; otpauth: string }
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.otpauth)}`
      setSetup({ ...data, qrUrl })
    } catch {
      setError("Failed to generate setup code")
    } finally {
      setLoading(false)
    }
  }

  const verifyAndEnable = async () => {
    if (!setup || !code) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: setup.secret, code }),
      })
      if (res.ok) {
        const data = await res.json() as { signInAgain?: boolean }
        setEnabled(true)
        setSetup(null)
        setCode("")
        setSignInAgain(data.signInAgain === true)
      } else {
        const data = await res.json() as { error?: string }
        setError(data.error ?? "Verification failed")
      }
    } catch {
      setError("Network error")
    } finally {
      setLoading(false)
    }
  }

  const disableTotp = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/settings/totp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      if (res.ok) {
        setEnabled(false)
        setDisabling(false)
        setCode("")
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? "Verification failed")
      }
    } catch {
      setError("Network error")
    } finally {
      setLoading(false)
    }
  }

  const copySecret = () => {
    if (setup?.secret) {
      navigator.clipboard.writeText(setup.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className={`rounded-lg border p-6 flex items-start gap-4 ${
        enabled ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200"
      }`}>
        {enabled ? (
          <ShieldCheck className="h-8 w-8 text-green-600 mt-1 shrink-0" />
        ) : (
          <Shield className="h-8 w-8 text-gray-400 mt-1 shrink-0" />
        )}
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Two-Factor Authentication {enabled ? "(Active)" : "(Inactive)"}
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            {enabled
              ? "Your account is protected with TOTP two-factor authentication. You will need your authenticator app each time you log in."
              : "Add an extra layer of security to your account. You'll need an authenticator app (Google Authenticator, Authy, etc.)."}
          </p>
          {enrolmentForced && !enabled && (
            <p className="text-sm font-medium text-gray-900 mt-3">
              Your organisation requires two-factor authentication. Set it up to continue.
            </p>
          )}
          {required && enabled && (
            <p className="text-sm text-gray-600 mt-3">
              Your organisation requires two-factor authentication, so it cannot be turned off.
            </p>
          )}
          {signInAgain ? (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium text-gray-900">
                Two-factor authentication is on. Sign in again with a code from your authenticator app.
              </p>
              <Button size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>Sign in again</Button>
            </div>
          ) : (
            <div className="mt-4 flex gap-3">
              {enabled ? (
                !required && !disabling && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setDisabling(true); setCode(""); setError(null) }}
                    className="border-red-300 text-red-600 hover:bg-red-50"
                  >
                    <ShieldOff className="h-4 w-4 mr-2" />
                    Disable 2FA
                  </Button>
                )
              ) : (
                !setup && (
                  <Button size="sm" onClick={startSetup} disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Shield className="h-4 w-4 mr-2" />}
                    Enable 2FA
                  </Button>
                )
              )}
            </div>
          )}
          {enabled && disabling && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-gray-600">Enter the 6-digit code from your authenticator app to turn off two-factor authentication:</p>
              {error && (
                <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>
              )}
              <div className="flex gap-3">
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  className="border border-gray-300 rounded px-4 py-2 text-lg font-mono tracking-widest w-40 focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
                />
                <Button variant="outline" onClick={disableTotp} disabled={code.length !== 6 || loading}
                  className="border-red-300 text-red-600 hover:bg-red-50">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ShieldOff className="h-4 w-4 mr-2" />}
                  Confirm
                </Button>
                <Button variant="ghost" onClick={() => { setDisabling(false); setCode(""); setError(null) }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Setup flow */}
      {setup && !enabled && (
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-6 space-y-5">
          <h3 className="font-semibold text-[#1b1d24]">Set Up Authenticator App</h3>

          <div className="flex gap-6 items-start">
            {/* QR code */}
            <div className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={setup.qrUrl}
                alt="QR code for authenticator app"
                width={180}
                height={180}
                className="border rounded-lg"
              />
            </div>
            <div className="space-y-3 flex-1">
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Step 1</p>
                <p className="text-sm text-gray-600">
                  Open your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.) and scan this QR code.
                </p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Or enter this key manually:</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-100 px-3 py-1.5 rounded font-mono break-all">{setup.secret}</code>
                  <button onClick={copySecret} className="text-gray-400 hover:text-gray-700 shrink-0">
                    {copied ? <CheckCircle className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <p className="text-sm text-gray-600">
                  Account: <strong>{email}</strong>
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t border-[#e5e7eb] pt-4">
            <p className="text-sm font-medium text-gray-700">Step 2 — Verify</p>
            <p className="text-sm text-gray-600">Enter the 6-digit code from your authenticator app to complete setup:</p>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>
            )}
            <div className="flex gap-3">
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="border border-gray-300 rounded px-4 py-2 text-lg font-mono tracking-widest w-40 focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
              />
              <Button onClick={verifyAndEnable} disabled={code.length !== 6 || loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                Verify & Enable
              </Button>
              <Button variant="ghost" onClick={() => { setSetup(null); setCode(""); setError(null) }}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
