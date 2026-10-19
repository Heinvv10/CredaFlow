"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"

const TEXT = [
  ["name", "Name", true], ["registrationNumber", "Registration number", false], ["vatNumber", "VAT number (makes it a VAT vendor)", false],
  ["contactEmail", "Contact email", true], ["contactPhone", "Contact phone", false],
] as const
type Key = (typeof TEXT)[number][0]

/** Registers a dealer or broker, then opens its page to add its first dealer admin, rates and bank account. */
export function DealerCreateForm({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Partial<Record<Key, string>>>({})
  const [kind, setKind] = useState<"DEALER" | "BROKER">("DEALER")
  const [supplierId, setSupplierId] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>New dealer</Button>

  const submit = async () => {
    const body: Record<string, string> = { kind }
    for (const [key] of TEXT) {
      const value = values[key]?.trim()
      if (value) body[key] = value
    }
    if (supplierId) body.supplierId = supplierId
    setSaving(true)
    setError(null)
    setFields({})
    const result = await sendJson("/api/asset-finance/dealers", "POST", body)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    router.push(`/asset-finance/dealers/${(result.body as { id: string }).id}`)
  }

  const supplierOptions = Object.fromEntries([["", "None"], ...suppliers.map((s) => [s.id, s.name])]) as Record<string, string>
  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">New dealer or broker</h3>
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {TEXT.map(([key, label, required]) => (
          <TextField key={key} id={`dealer-${key}`} label={label} required={required} value={values[key] ?? ""}
            onChange={(value) => setValues((v) => ({ ...v, [key]: value }))} error={fields[key]} />
        ))}
        <SelectField id="dealer-kind" label="Kind" value={kind} onChange={setKind} options={{ DEALER: "Dealer", BROKER: "Broker" }} error={fields.kind} />
        <SelectField id="dealer-supplier" label="Default supplier on its deals" value={supplierId} onChange={setSupplierId}
          options={supplierOptions} error={fields.supplierId} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {saving ? "Saving…" : "Register dealer"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  )
}
