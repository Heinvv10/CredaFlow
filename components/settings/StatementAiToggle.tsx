"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted value, read on the server. */
  enabled: boolean
  /** The viewer is a SUPER_ADMIN (the route enforces it again). */
  canChange: boolean
}

export function StatementAiToggle({ enabled: initial, canChange }: Props) {
  const [enabled, setEnabled] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  async function handleChange(next: boolean) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/statement-ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureStatementAi: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setEnabled(next)
        setMessage({ kind: "success", text: next ? "Statement AI is on." : "Statement AI is off." })
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
        <CardTitle>Statement AI</CardTitle>
        <CardDescription>
          An advisory summary, flag explanations and questions on a client&apos;s statements, beside the statement insights.
          The credit checks still decide.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="featureStatementAi">Statement AI</Label>
            <p className="text-sm text-muted-foreground">{canChange ? "A paid option, metered per statement." : "Only a Super Admin can change this."}</p>
          </div>
          <Switch id="featureStatementAi" checked={enabled} disabled={saving || !canChange} onCheckedChange={handleChange} />
        </div>
        {message && <p role="status" className={`text-sm ${message.kind === "success" ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>{message.text}</p>}
      </CardContent>
    </Card>
  )
}
