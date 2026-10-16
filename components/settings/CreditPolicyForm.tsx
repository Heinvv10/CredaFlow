"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

// Kept in sync with lib/decision/credit-policy-input.ts (server is authoritative).
const SIGMA_MIN = 480
const SIGMA_MAX = 710
const SCORE_MIN_ALLOWED = 1
const NDI_MIN = 100
const NDI_MAX = 1000

interface PolicyForm {
  bureauMinScore: string
  bureauBlockAdverse: boolean
  ndiBufferPct: string
}

function validate(form: PolicyForm): { scoreError?: string; ndiError?: string } {
  const errors: { scoreError?: string; ndiError?: string } = {}
  const score = Number(form.bureauMinScore)
  if (
    form.bureauMinScore.trim() === "" ||
    !Number.isInteger(score) ||
    score < SCORE_MIN_ALLOWED ||
    score > SIGMA_MAX
  ) {
    errors.scoreError = `Enter a whole number between ${SCORE_MIN_ALLOWED} and ${SIGMA_MAX}.`
  }
  const ndi = Number(form.ndiBufferPct)
  if (
    form.ndiBufferPct.trim() === "" ||
    !Number.isInteger(ndi) ||
    ndi < NDI_MIN ||
    ndi > NDI_MAX
  ) {
    errors.ndiError = `Enter a whole number between ${NDI_MIN} and ${NDI_MAX}.`
  }
  return errors
}

async function fetchCreditPolicy(): Promise<PolicyForm> {
  const res = await fetch("/api/settings/credit-policy")
  if (!res.ok) throw new Error(String(res.status))
  const data = await res.json()
  return {
    bureauMinScore: String(data.bureauMinScore),
    bureauBlockAdverse: Boolean(data.bureauBlockAdverse),
    ndiBufferPct: String(data.ndiBufferPct),
  }
}

export function CreditPolicyForm() {
  const [form, setForm] = useState<PolicyForm>({
    bureauMinScore: "",
    bureauBlockAdverse: false,
    ndiBufferPct: "",
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  useEffect(() => {
    let ignore = false
    fetchCreditPolicy()
      .then((loaded) => { if (!ignore) setForm(loaded) })
      .catch(() => { if (!ignore) setMessage({ kind: "error", text: "Failed to load the current policy." }) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  const errors = validate(form)
  const hasErrors = !!(errors.scoreError || errors.ndiError)
  const showUncalibratedWarning = !errors.scoreError && Number(form.bureauMinScore) < SIGMA_MIN

  async function handleSave() {
    if (hasErrors) return
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/credit-policy", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bureauMinScore: Number(form.bureauMinScore),
          bureauBlockAdverse: form.bureauBlockAdverse,
          ndiBufferPct: Number(form.ndiBufferPct),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setMessage({ kind: "success", text: "Credit policy saved." })
      } else {
        setMessage({ kind: "error", text: data.error ?? "Failed to save the policy." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the policy." })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading current policy…</p>
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bureau score gate</CardTitle>
          <CardDescription>
            Minimum Experian Sigma score required to auto-approve an application. The Sigma band is{" "}
            {SIGMA_MIN}–{SIGMA_MAX}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="bureauMinScore">Minimum bureau score</Label>
            <Input
              id="bureauMinScore"
              type="number"
              inputMode="numeric"
              min={SCORE_MIN_ALLOWED}
              max={SIGMA_MAX}
              step={1}
              value={form.bureauMinScore}
              onChange={(e) => setForm((p) => ({ ...p, bureauMinScore: e.target.value }))}
            />
            {errors.scoreError && <p className="text-sm text-red-600">{errors.scoreError}</p>}
          </div>

          {showUncalibratedWarning && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <strong>Uncalibrated (fail-safe).</strong> A minimum below {SIGMA_MIN} is outside the Sigma
              band, so every approval will require a manual s.81 override. Set a value between {SIGMA_MIN}{" "}
              and {SIGMA_MAX} to calibrate the gate.
            </div>
          )}

          <div className="flex items-center justify-between gap-4 max-w-md pt-2">
            <div>
              <Label htmlFor="bureauBlockAdverse">Block adverse bureau information</Label>
              <p className="text-sm text-muted-foreground">
                Decline applicants flagged with adverse account information at the bureau.
              </p>
            </div>
            <Switch
              id="bureauBlockAdverse"
              checked={form.bureauBlockAdverse}
              onCheckedChange={(checked) => setForm((p) => ({ ...p, bureauBlockAdverse: checked }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Affordability buffer</CardTitle>
          <CardDescription>
            Net disposable income (NDI) must be at least the proposed instalment × this percentage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-w-xs">
            <Label htmlFor="ndiBufferPct">NDI buffer (%)</Label>
            <Input
              id="ndiBufferPct"
              type="number"
              inputMode="numeric"
              min={NDI_MIN}
              max={NDI_MAX}
              step={1}
              value={form.ndiBufferPct}
              onChange={(e) => setForm((p) => ({ ...p, ndiBufferPct: e.target.value }))}
            />
            {errors.ndiError && <p className="text-sm text-red-600">{errors.ndiError}</p>}
            <p className="text-sm text-muted-foreground">
              e.g. 110 = NDI must be ≥ 1.10 × the instalment. Minimum {NDI_MIN}.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || hasErrors}>
          {saving ? "Saving…" : "Save policy"}
        </Button>
        {message && (
          <span className={`text-sm ${message.kind === "success" ? "text-green-600" : "text-red-600"}`}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
