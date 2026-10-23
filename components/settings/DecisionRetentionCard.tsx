"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface Props {
  /** Current persisted period in months, read on the server; null = off. */
  months: number | null
  /** The viewer is a SUPER_ADMIN (the route enforces it again, with a TOTP-verified session). */
  canChange: boolean
  /** Who changed it last and when, already formatted; null when never. */
  lastChange?: string | null
}

const DEFAULT_MONTHS = 60

export function DecisionRetentionCard({ months, canChange, lastChange = null }: Props) {
  const router = useRouter()
  const [saved, setSaved] = useState(months)
  const [on, setOn] = useState(months !== null)
  const [value, setValue] = useState(String(months ?? DEFAULT_MONTHS))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  const next = on ? Number(value) : null
  const valid = next === null || (Number.isInteger(next) && next >= 1 && next <= 600)

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/decision-record-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ months: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setSaved(next)
        setMessage({
          kind: "success",
          text: next === null
            ? "Retention is off: no credit decision record is pseudonymised."
            : `Saved: decision records older than ${next} months are pseudonymised each night.`,
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

  const disabled = saving || !canChange
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit decision log retention</CardTitle>
        <CardDescription>
          Once a decision record is older than this, a nightly job removes who it was about (the application, loan,
          client and lead, and the staff member), any override reason, the references to its source and evidence,
          and the fingerprint of its inputs. Its banded figures and outcomes stay, so performance reporting keeps
          working. A declined or refused decision ages from the day it was made;
          a decision on an application that became a loan ages from the day the loan was settled, written off or
          cancelled. An open loan&apos;s decisions never age, nor does a client-only record while that client has an open
          loan or live application. Pseudonymising cannot be undone. Confirm the period
          with your legal team.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 max-w-md">
          <div>
            <Label htmlFor="decisionRetentionOn">Pseudonymise aged decision records</Label>
            <p className="text-sm text-muted-foreground">
              {canChange
                ? "Off until a period is set. Changing this needs a session signed in with two-factor authentication."
                : "Only a Super Admin can change this."}
            </p>
          </div>
          <Switch id="decisionRetentionOn" checked={on} disabled={disabled} onCheckedChange={setOn} />
        </div>
        {on && (
          <div className="flex items-end gap-3 max-w-md">
            <div className="flex-1 space-y-1">
              <Label htmlFor="decisionRetentionMonths">Retention period (months, 1 to 600)</Label>
              <Input
                id="decisionRetentionMonths" type="number" min={1} max={600} step={1}
                value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
        )}
        {canChange && (
          <Button onClick={save} disabled={disabled || !valid || next === saved}>
            {saving ? "Saving…" : "Save retention setting"}
          </Button>
        )}
        <p className="text-sm text-muted-foreground">{lastChange ?? "Never changed."}</p>
        {message && (
          <p className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>{message.text}</p>
        )}
      </CardContent>
    </Card>
  )
}
