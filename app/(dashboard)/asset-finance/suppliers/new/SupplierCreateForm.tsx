"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

const FIELDS = [
  ["name", "Name", true], ["registrationNumber", "Registration number", false], ["vatNumber", "VAT number", false],
  ["contactName", "Contact person", false], ["contactEmail", "Contact email", false], ["contactPhone", "Contact phone", false],
  ["address", "Address", false],
] as const
type Key = (typeof FIELDS)[number][0]

export function SupplierCreateForm() {
  const router = useRouter()
  const [values, setValues] = useState<Partial<Record<Key, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const body: Record<string, string> = {}
    for (const [key] of FIELDS) {
      const value = values[key]?.trim()
      if (value) body[key] = value
    }
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson("/api/asset-finance/suppliers", "POST", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    router.push(`/asset-finance/suppliers/${(result.body as { id: string }).id}`)
  }

  return (
    <DataPanel title="Supplier details" density="loose">
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {FIELDS.map(([key, label, required]) => (
            <TextField key={key} id={key} label={label} required={required} value={values[key] ?? ""}
              onChange={(value) => setValues((prev) => ({ ...prev, [key]: value }))} error={fields[key]} />
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {saving ? "Saving…" : "Create supplier"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => router.push("/asset-finance/suppliers")}>Cancel</Button>
        </div>
      </div>
    </DataPanel>
  )
}
