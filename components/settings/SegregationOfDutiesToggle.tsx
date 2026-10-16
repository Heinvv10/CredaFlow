"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted value, read on the server. */
  required: boolean
  /** The viewer is an ADMIN or SUPER_ADMIN (the route enforces it again). */
  canChange: boolean
  /** Who changed it last and when, already formatted; null when never. */
  lastChange?: string | null
}

export function SegregationOfDutiesToggle({ required: initial, canChange, lastChange = null }: Props) {
  const router = useRouter()
  const [required, setRequired] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  async function handleChange(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/segregation-of-duties", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireSegregationOfDuties: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setRequired(next)
        setMessage({
          kind: "success",
          text: next ? "Segregation of duties is now on." : "Segregation of duties is now off.",
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
        <CardTitle>Segregation of duties</CardTitle>
        <CardDescription>
          When on, two different staff members are needed for each of these pairs: approving an
          application and disbursing it; witnessing a client&apos;s in-branch signature and
          countersigning for the lender; creating an asset-finance payout and approving it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="requireSegregationOfDuties">Require segregation of duties</Label>
            <p className="text-sm text-muted-foreground">
              {canChange
                ? "Recommended on. Turning it off needs a session signed in with two-factor authentication; every change is recorded in the audit log."
                : "Only an Admin or Super Admin can change this."}
            </p>
          </div>
          <Switch
            id="requireSegregationOfDuties"
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
