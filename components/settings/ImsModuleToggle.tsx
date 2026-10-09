"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted value, read on the server. */
  featureIms: boolean
}

export function ImsModuleToggle({ featureIms }: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(featureIms)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  async function handleChange(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/ims", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureIms: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setEnabled(next)
        setMessage({
          kind: "success",
          text: next ? "Insurance module switched on." : "Insurance module switched off.",
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
        <CardTitle>Insurance module</CardTitle>
        <CardDescription>
          Shows or hides the insurance and compliance sections of the staff app and the insurance
          API. It does not authorise any sale — see product readiness below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="featureIms">Insurance module enabled</Label>
            {/*
              The gating boundary is deliberate, and this sentence has to match
              it exactly. `requireImsEnabled` gates the /api/insurance routes,
              and the Insurance and Compliance dashboard layouts redirect. It
              does NOT gate insurer or insurance-product setup — live credit
              life reads those records, so closing them would break production.
              An earlier version of this line promised "staff cannot reach any
              insurance screen or endpoint", which was false in four places.
            */}
            <p className="text-sm text-muted-foreground">
              Off hides the Insurance and Compliance sections and closes the insurance API. Insurer
              and insurance product setup, under Settings, stays open either way — credit life
              depends on those records.
            </p>
          </div>
          <Switch
            id="featureIms"
            checked={enabled}
            disabled={saving}
            onCheckedChange={handleChange}
          />
        </div>
        {message && (
          <p className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
