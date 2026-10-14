"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { KycOverrideMinRole } from "@/lib/kyc/override-policy"

interface Props {
  enabled: boolean
  minRole: KycOverrideMinRole
  secondApprover: boolean
  canChange: boolean
  lastChange?: string | null
}

export function KycOverridePolicyCard(props: Props) {
  const router = useRouter()
  const [policy, setPolicy] = useState({
    enabled: props.enabled,
    minRole: props.minRole,
    secondApprover: props.secondApprover,
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)

  async function save(next: typeof policy) {
    setSaving(true)
    setMessage(null)
    try {
      const response = await fetch("/api/settings/security-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kycOverrideEnabled: next.enabled,
          kycOverrideMinRole: next.minRole,
          kycOverrideSecondApprover: next.secondApprover,
        }),
      })
      const data = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) {
        setMessage({ error: true, text: data.error ?? "Failed to save the KYC override policy." })
        return
      }
      setPolicy(next)
      setMessage({ error: false, text: "KYC override policy saved." })
      router.refresh()
    } catch {
      setMessage({ error: true, text: "Failed to save the KYC override policy." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>KYC overrides</CardTitle>
        <CardDescription>
          Controls who may override a failed selfie or record an in-person verification.
          A clear face mismatch can never be overridden by the selfie exception path.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex max-w-xl items-center justify-between gap-4">
          <div>
            <Label htmlFor="kycOverrideEnabled">Allow KYC overrides</Label>
            <p className="text-sm text-muted-foreground">
              Turning this off blocks new overrides, new requests, and approval of pending requests. Existing grants remain valid.
            </p>
          </div>
          <Switch
            id="kycOverrideEnabled"
            checked={policy.enabled}
            disabled={saving || !props.canChange}
            onCheckedChange={(enabled) => void save({ ...policy, enabled })}
          />
        </div>
        <div className="max-w-sm space-y-2">
          <Label htmlFor="kycOverrideMinRole">Minimum senior role</Label>
          <select
            id="kycOverrideMinRole"
            value={policy.minRole}
            disabled={saving || !props.canChange}
            onChange={(event) => void save({ ...policy, minRole: event.target.value as KycOverrideMinRole })}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="BRANCH_MANAGER">Branch Manager</option>
            <option value="ADMIN">Admin</option>
          </select>
        </div>
        <div className="flex max-w-xl items-center justify-between gap-4">
          <div>
            <Label htmlFor="kycOverrideSecondApprover">Require a second approver</Label>
            <p className="text-sm text-muted-foreground">The approver must be a different eligible senior. Requests expire after 7 days.</p>
          </div>
          <Switch
            id="kycOverrideSecondApprover"
            checked={policy.secondApprover}
            disabled={saving || !props.canChange}
            onCheckedChange={(secondApprover) => void save({ ...policy, secondApprover })}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {props.canChange ? "Changing this needs a TOTP-verified Super Admin session." : "Only a Super Admin can change this."}
        </p>
        <p className="text-sm text-muted-foreground">{props.lastChange ?? "Never changed."}</p>
        {message && <p className={`text-sm ${message.error ? "text-red-600" : "text-green-600"}`}>{message.text}</p>}
      </CardContent>
    </Card>
  )
}
