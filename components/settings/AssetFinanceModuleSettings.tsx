"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { randsToCents } from "@/lib/asset-finance/money-input"

interface Props {
  featureAssetFinance: boolean
  assetPayoutDualApprovalCents: number
  assetFinanceLegalWordingApproved: boolean
}

const rands = (cents: number) => (cents / 100).toFixed(2)

/** The asset-finance switch, payout threshold and (read-only) legal-wording gate. ADMIN; every change audited. */
export function AssetFinanceModuleSettings(props: Props) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(props.featureAssetFinance)
  const [threshold, setThreshold] = useState(rands(props.assetPayoutDualApprovalCents))
  const [saving, setSaving] = useState<"switch" | "threshold" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [saved, setSaved] = useState<string | null>(null)

  const save = async (kind: "switch" | "threshold", body: Record<string, unknown>, done: string) => {
    setSaving(kind)
    setError(null)
    setSaved(null)
    const result = await sendJson("/api/settings/asset-finance", "PATCH", body)
    setSaving(null)
    if (!result.ok) {
      setError(result.error)
      setFieldError(result.fields.assetPayoutDualApprovalCents)
      return false
    }
    setSaved(done)
    router.refresh()
    return true
  }

  const toggle = async (next: boolean) => {
    if (await save("switch", { featureAssetFinance: next }, next ? "Asset finance switched on." : "Asset finance switched off.")) setEnabled(next)
  }

  const saveThreshold = async () => {
    const cents = randsToCents(threshold)
    setFieldError(undefined)
    if (cents === null) {
      setFieldError("Enter an amount in rand, e.g. 1000000")
      return
    }
    await save("threshold", { assetPayoutDualApprovalCents: cents }, "Payout approval threshold saved.")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asset finance</CardTitle>
        <CardDescription>
          Instalment sale and leasing for companies and trusts: entities, deals, assets, suppliers and reference rates.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FormError message={error} />
        <div className="flex max-w-md items-center justify-between gap-4">
          <div>
            <Label htmlFor="featureAssetFinance">Asset finance module enabled</Label>
            <p className="text-sm text-[var(--cf-text-muted)]">
              Off hides the Asset Finance section and the business portal, and closes the asset-finance API.
            </p>
          </div>
          <Switch id="featureAssetFinance" checked={enabled} disabled={saving !== null} onCheckedChange={toggle} />
        </div>

        <div className="max-w-md space-y-2">
          <TextField
            id="assetPayoutDualApprovalCents"
            label="Second payout approver from (R)"
            inputMode="decimal"
            value={threshold}
            onChange={setThreshold}
            error={fieldError}
          />
          <p className="text-xs text-[var(--cf-text-muted)]">
            A payout of this amount or more needs a second, different approver. 0 means every payout does.
          </p>
          <Button size="sm" variant="outline" onClick={saveThreshold} disabled={saving !== null}>
            {saving === "threshold" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save threshold
          </Button>
        </div>

        <div className="max-w-md space-y-1">
          <p className="text-sm font-medium text-[var(--cf-text)]">
            Agreement wording approved: {props.assetFinanceLegalWordingApproved ? "Yes" : "No — documents carry a DRAFT watermark"}
          </p>
          <p className="text-xs text-[var(--cf-text-muted)]">
            Set by CredaFlow once the lender&apos;s legal team approves the agreement wording
          </p>
        </div>

        {saved && <p className="text-sm text-[var(--cf-success)]">{saved}</p>}
      </CardContent>
    </Card>
  )
}
