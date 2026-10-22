"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

/**
 * How long a tracker position is kept before the nightly purge (POPIA; the
 * database allows 1 to 365 days, default 90). ADMIN; audited.
 */
export function TelematicsRetentionSettings(props: { telematicsPositionRetentionDays: number }) {
  const router = useRouter()
  const [days, setDays] = useState(String(props.telematicsPositionRetentionDays))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  const save = async () => {
    const value = Number(days)
    setError(null)
    setSaved(false)
    if (!Number.isInteger(value)) return setFieldError("Enter a whole number of days")
    setFieldError(undefined)
    setSaving(true)
    const result = await sendJson("/api/settings/asset-finance", "PATCH", { telematicsPositionRetentionDays: value })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFieldError(result.fields.telematicsPositionRetentionDays)
      return
    }
    setSaved(true)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tracker positions</CardTitle>
        <CardDescription>
          A financed asset&apos;s tracker positions are personal data. They are shown only to collections staff on a loan in default,
          legal action or recovery, every view is logged, and they are deleted after this many days.
        </CardDescription>
      </CardHeader>
      <CardContent className="max-w-md space-y-3">
        <FormError message={error} />
        <TextField id="telematicsPositionRetentionDays" label="Keep positions for (days)" inputMode="numeric" value={days} onChange={setDays} error={fieldError} />
        <p className="text-xs text-[var(--cf-text-muted)]">1 to 365 days. A longer period needs your legal team&apos;s sign-off and a change by CredaFlow.</p>
        <Button size="sm" variant="outline" onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Save retention
        </Button>
        {saved && <p className="text-sm text-[var(--cf-success)]">Retention saved.</p>}
      </CardContent>
    </Card>
  )
}
