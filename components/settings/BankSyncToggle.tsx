"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted value, read on the server. */
  bankSyncEnabled: boolean
}

export function BankSyncToggle({ bankSyncEnabled }: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(bankSyncEnabled)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  async function handleChange(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/bank-sync", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankSyncEnabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setEnabled(next)
        setMessage({
          kind: "success",
          text: next ? "Bank statement import switched on." : "Bank statement import switched off.",
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
        <CardTitle>Bank statement import</CardTitle>
        <CardDescription>
          Allows staff to upload bank-statement CSVs under Payments → Bank reconciliation. Uploads
          are refused while this is off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="bankSyncEnabled">Bank statement import enabled</Label>
            <p className="text-sm text-muted-foreground">
              Changing this needs a session signed in with two-factor authentication.
            </p>
          </div>
          <Switch
            id="bankSyncEnabled"
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
