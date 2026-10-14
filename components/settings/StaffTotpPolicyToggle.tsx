"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted value, read on the server. */
  requireStaffTotp: boolean
  /** The viewer is a SUPER_ADMIN (the route enforces it again). */
  canChange: boolean
  /** Who changed it last and when, already formatted; null when never. */
  lastChange?: string | null
}

export function StaffTotpPolicyToggle({ requireStaffTotp, canChange, lastChange = null }: Props) {
  const router = useRouter()
  const [required, setRequired] = useState(requireStaffTotp)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  async function handleChange(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/security-policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireStaffTotp: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setRequired(next)
        setMessage({
          kind: "success",
          text: next ? "Two-factor authentication is now required for staff." : "Two-factor authentication is no longer required for staff.",
        })
        router.refresh()
      } else {
        setMessage({ kind: "error", text: data.error ?? "Failed to save the setting." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the setting." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff two-factor authentication</CardTitle>
        <CardDescription>
          When on, a staff member without two-factor authentication can reach only the setup page
          until they have set it up.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="requireStaffTotp">Require two-factor authentication for staff</Label>
            <p className="text-sm text-muted-foreground">
              {canChange
                ? "Changing this needs a session signed in with two-factor authentication."
                : "Only a Super Admin can change this."}
            </p>
          </div>
          <Switch
            id="requireStaffTotp"
            checked={required}
            disabled={saving || !canChange}
            onCheckedChange={handleChange}
          />
        </div>
        <p className="text-sm text-muted-foreground">{lastChange ?? "Never changed."}</p>
        {message && (
          <p className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
