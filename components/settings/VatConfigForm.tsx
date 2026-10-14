"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

interface VatDetails {
  vatNumber: string
  registeredName: string
  address: string
}

/**
 * The lender's VAT vendor details, printed as the supplier on every tax
 * invoice. The API (PUT /api/asset-finance/vat-config) is closed while asset
 * finance is off, so the form waits for the module switch.
 */
export function VatConfigForm({ initial, moduleEnabled }: { initial: VatDetails | null; moduleEnabled: boolean }) {
  const router = useRouter()
  const [values, setValues] = useState<VatDetails>(initial ?? { vatNumber: "", registeredName: "", address: "" })
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const set = (key: keyof VatDetails) => (value: string) => setValues((prev) => ({ ...prev, [key]: value }))

  const submit = async () => {
    setSaving(true)
    setError(null)
    setFields({})
    setSaved(false)
    const result = await sendJson("/api/asset-finance/vat-config", "PUT", values)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    setSaved(true)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>VAT vendor details</CardTitle>
        <CardDescription>
          Printed as the supplier on every asset-finance tax invoice. Invoices already issued keep the details they were issued with.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!moduleEnabled ? (
          <p className="text-sm text-[var(--cf-text-muted)]">Switch asset finance on to set the VAT details.</p>
        ) : (
          <>
            <FormError message={error} />
            {!initial && (
              <p className="text-sm text-[var(--cf-warning)]">Not set yet: no tax invoice can be issued until it is.</p>
            )}
            <div className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
              <TextField id="vatNumber" label="VAT number" required inputMode="numeric" placeholder="4XXXXXXXXX" value={values.vatNumber} onChange={set("vatNumber")} error={fields.vatNumber} />
              <TextField id="registeredName" label="Registered name" required value={values.registeredName} onChange={set("registeredName")} error={fields.registeredName} />
              <div className="md:col-span-2">
                <TextField id="address" label="Address" required value={values.address} onChange={set("address")} error={fields.address} />
              </div>
            </div>
            <Button size="sm" onClick={submit} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {saving ? "Saving…" : "Save VAT details"}
            </Button>
            {saved && <p className="text-sm text-[var(--cf-success)]">VAT details saved.</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}
