"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

interface Props {
  featureDealerPortal: boolean
  dealerCommissionClawbackMonths: number
  isDemoLender: boolean
}

/**
 * The dealer portal switch (a demo lender only, until dealer two-factor
 * sign-in ships; the database refuses it otherwise) and the commission
 * clawback window. ADMIN; every change audited.
 */
export function DealerPortalSettings(props: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(props.featureDealerPortal)
  const [months, setMonths] = useState(String(props.dealerCommissionClawbackMonths))
  const [saving, setSaving] = useState<"switch" | "months" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [saved, setSaved] = useState<string | null>(null)

  const save = async (kind: "switch" | "months", body: Record<string, unknown>, done: string) => {
    setSaving(kind)
    setError(null)
    setSaved(null)
    setFieldError(undefined)
    const result = await sendJson("/api/settings/asset-finance", "PATCH", body)
    setSaving(null)
    if (!result.ok) {
      setError(result.error)
      setFieldError(result.fields.dealerCommissionClawbackMonths)
      return false
    }
    setSaved(done)
    router.refresh()
    return true
  }

  const toggle = async (next: boolean) => {
    if (await save("switch", { featureDealerPortal: next }, next ? "Dealer portal switched on." : "Dealer portal switched off; dealer sessions end.")) setEnabled(next)
  }
  const saveMonths = () => {
    const value = Number(months)
    if (!Number.isInteger(value)) return setFieldError("Enter a whole number of months, 0 to switch clawback off")
    return save("months", { dealerCommissionClawbackMonths: value }, "Clawback window saved.")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dealer portal</CardTitle>
        <CardDescription>Dealers and brokers capture deals for you; you accept, decide and pay their commission.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FormError message={error} />
        <div className="flex max-w-md items-center justify-between gap-4">
          <div>
            <Label htmlFor="featureDealerPortal">Dealer portal enabled</Label>
            <p className="text-sm text-[var(--cf-text-muted)]">
              {props.isDemoLender
                ? "Off ends every dealer session and closes dealer sign-in. Earned commission can still be paid."
                : "Available on a demo lender only until dealer two-factor sign-in ships."}
            </p>
          </div>
          <Switch id="featureDealerPortal" checked={enabled} disabled={saving !== null || (!props.isDemoLender && !enabled)} onCheckedChange={toggle} />
        </div>
        <div className="max-w-md space-y-2">
          <TextField id="dealerCommissionClawbackMonths" label="Commission clawback window (months)" inputMode="numeric"
            value={months} onChange={setMonths} error={fieldError} />
          <p className="text-xs text-[var(--cf-text-muted)]">
            A contract settled early or written off within this many months of booking reverses the dealer&apos;s commission. 0 switches it off;
            a cancelled contract always reverses it. Applies to commission earned from now on.
          </p>
          <Button size="sm" variant="outline" onClick={saveMonths} disabled={saving !== null}>
            {saving === "months" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save window
          </Button>
        </div>
        {saved && <p className="text-sm text-[var(--cf-success)]">{saved}</p>}
      </CardContent>
    </Card>
  )
}
