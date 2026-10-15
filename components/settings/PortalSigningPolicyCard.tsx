"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

type Policy = { requireSigningOtp: boolean; signingOtpBranchExempt: boolean; allowNewRegistrations: boolean }

interface Props extends Policy {
  /** The viewer is a SUPER_ADMIN (the route enforces it again). */
  canChange: boolean
  /** TenantConfig.featurePortal, set in the tenant admin; shown for context. */
  portalEnabled: boolean
  lastChange?: string | null
}

const ROWS: { key: keyof Policy; label: string; help: string }[] = [
  {
    key: "requireSigningOtp",
    label: "Require a one-time code for portal signing",
    help: "Borrowers verify a code sent by email or WhatsApp before signing the credit agreement, the debit mandate or an asset-finance document in the portal.",
  },
  {
    key: "signingOtpBranchExempt",
    label: "Exempt witnessed branch signing",
    help: "When on, a branch signing recorded by a staff witness needs no code. Off: the witness enters the code the borrower receives.",
  },
  {
    key: "allowNewRegistrations",
    label: "Allow new portal registrations",
    help: "Off refuses new portal activations. Borrowers who already activated keep signing in.",
  },
]

export function PortalSigningPolicyCard({ canChange, portalEnabled, lastChange = null, ...initial }: Props) {
  const router = useRouter()
  const [policy, setPolicy] = useState<Policy>(initial)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  async function save(next: Policy) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/portal-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setPolicy(next)
        setMessage({ error: false, text: "Saved." })
        router.refresh()
      } else {
        setMessage({ error: true, text: data.error ?? "Failed to save the setting." })
      }
    } catch {
      setMessage({ error: true, text: "Failed to save the setting." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client portal and signing</CardTitle>
        <CardDescription>
          The client portal is {portalEnabled ? "on" : "off"} for this lender
          {portalEnabled ? "." : ": portal sign-in, registration and password reset are refused."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {ROWS.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 max-w-xl">
            <div>
              <Label htmlFor={row.key}>{row.label}</Label>
              <p className="text-sm text-muted-foreground">{row.help}</p>
            </div>
            <Switch
              id={row.key}
              checked={policy[row.key]}
              disabled={saving || !canChange}
              onCheckedChange={(value) => save({ ...policy, [row.key]: value })}
            />
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          {canChange ? "Changing these needs a session signed in with two-factor authentication." : "Only a Super Admin can change these."}
        </p>
        <p className="text-sm text-muted-foreground">{lastChange ?? "Never changed."}</p>
        {message && (
          <p className={`text-sm ${message.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{message.text}</p>
        )}
      </CardContent>
    </Card>
  )
}
