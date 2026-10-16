"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

// Validation lives on the server (lib/config/identity.ts); this form shows its
// per-field errors rather than keeping a second copy of the rules.
type Field =
  | "legalName" | "brandName" | "ncrNumber" | "fscaNumber" | "companyRegNumber"
  | "registeredOffice" | "publicEmail" | "publicPhone" | "publicWhatsapp"
  | "collectionsEmail" | "collectionsPhone" | "collectionsPhoneSecondary" | "brandTagline"
  | "ncrRegistrationDate" | "fscaAuthorisationDate" | "ncrStatus" | "headOfficeCity"
type Statutory = "ncrNumber" | "fscaNumber" | "companyRegNumber"
type Values = Record<Field, string>
type Errors = Partial<Record<Field | `${Statutory}Confirm` | "form", string>>

const EMPTY: Values = {
  legalName: "", brandName: "", ncrNumber: "", fscaNumber: "", companyRegNumber: "",
  registeredOffice: "", publicEmail: "", publicPhone: "", publicWhatsapp: "",
  collectionsEmail: "", collectionsPhone: "", collectionsPhoneSecondary: "", brandTagline: "",
  ncrRegistrationDate: "", fscaAuthorisationDate: "", ncrStatus: "", headOfficeCity: "",
}

const NCR_STATUS_OPTIONS = ["Registered", "Suspended", "Cancelled", "Deregistered"]

type FieldSpec = { key: Field; label: string; hint?: string; multiline?: boolean; type?: "date"; options?: string[] }

const SECTIONS: { title: string; description: string; fields: FieldSpec[] }[] = [
  {
    title: "Registered entity",
    description: "Printed on every NCA document. The three registration numbers must be typed twice whenever they change.",
    fields: [
      { key: "legalName", label: "Legal name", hint: "e.g. Example Lending (Pty) Ltd" },
      { key: "brandName", label: "Trading name", hint: "Used in customer emails, SMS and the portal" },
      { key: "ncrNumber", label: "NCR registration number", hint: "NCRCP followed by digits" },
      { key: "fscaNumber", label: "FSP licence number", hint: "Digits only" },
      { key: "companyRegNumber", label: "Company registration number", hint: "e.g. 2020/123456/07" },
      { key: "registeredOffice", label: "Registered office", hint: "One address line per line, up to 6", multiline: true },
    ],
  },
  {
    title: "Customer contact",
    description: "Shown to customers in the portal and in every message.",
    fields: [
      { key: "publicEmail", label: "Public email" },
      { key: "publicPhone", label: "Public phone", hint: "+27 and 9 digits" },
      { key: "publicWhatsapp", label: "WhatsApp number (optional)", hint: "Leave empty to hide WhatsApp links" },
    ],
  },
  {
    title: "Collections",
    description: "Used on reminders and collections correspondence.",
    fields: [
      { key: "collectionsEmail", label: "Collections email" },
      { key: "collectionsPhone", label: "Collections phone" },
      { key: "collectionsPhoneSecondary", label: "Second collections phone (optional)" },
      { key: "brandTagline", label: "Letterhead tagline (optional)" },
    ],
  },
  {
    title: "Regulatory details",
    description: "Shown on the public regulatory information page. Each is optional; a line with no value is left off the page.",
    fields: [
      { key: "ncrRegistrationDate", label: "NCR final registration date (optional)", type: "date" },
      { key: "ncrStatus", label: "NCR status (optional)", options: NCR_STATUS_OPTIONS },
      { key: "fscaAuthorisationDate", label: "FSCA authorisation date (optional)", type: "date" },
      { key: "headOfficeCity", label: "Head office city (optional)", hint: "e.g. Sandton" },
    ],
  },
]

const STATUTORY: Statutory[] = ["ncrNumber", "fscaNumber", "companyRegNumber"]

async function fetchIdentity(): Promise<Values> {
  const res = await fetch("/api/settings/identity")
  if (!res.ok) throw new Error(String(res.status))
  const { identity } = await res.json() as { identity: Record<Field, string | null> }
  return Object.fromEntries(Object.keys(EMPTY).map((k) => [k, identity[k as Field] ?? ""])) as Values
}

export function LenderIdentityForm() {
  const [stored, setStored] = useState<Values>(EMPTY)
  const [form, setForm] = useState<Values>(EMPTY)
  const [confirm, setConfirm] = useState<Record<Statutory, string>>({ ncrNumber: "", fscaNumber: "", companyRegNumber: "" })
  const [errors, setErrors] = useState<Errors>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)

  function applyIdentity(values: Values) {
    setStored(values)
    setForm(values)
    setConfirm({ ncrNumber: "", fscaNumber: "", companyRegNumber: "" })
  }

  // Used after a save: shows the loading state again while the form is rebuilt
  // from what the server stored.
  async function reload() {
    setLoading(true)
    try {
      applyIdentity(await fetchIdentity())
    } catch {
      setMessage({ kind: "error", text: "Failed to load the lender identity." })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let ignore = false
    fetchIdentity()
      .then((values) => { if (!ignore) applyIdentity(values) })
      .catch(() => { if (!ignore) setMessage({ kind: "error", text: "Failed to load the lender identity." }) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [])

  const changed = (key: Statutory) => form[key].trim().toUpperCase() !== stored[key].trim().toUpperCase()

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    setErrors({})
    try {
      const res = await fetch("/api/settings/identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          ncrNumberConfirm: confirm.ncrNumber,
          fscaNumberConfirm: confirm.fscaNumber,
          companyRegNumberConfirm: confirm.companyRegNumber,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setMessage({ kind: "success", text: data.changed ? "Lender identity saved." : "No changes to save." })
        await reload()
      } else {
        setErrors(data.errors ?? {})
        setMessage({ kind: "error", text: data.error ?? "Failed to save the lender identity." })
      }
    } catch {
      setMessage({ kind: "error", text: "Failed to save the lender identity." })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading lender identity…</p>
  }

  return (
    <div className="space-y-6">
      {SECTIONS.map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            <CardDescription>{section.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {section.fields.map(({ key, label, hint, multiline, type, options }) => (
              <div key={key} className="space-y-2 max-w-md">
                <Label htmlFor={key}>{label}</Label>
                {multiline ? (
                  <textarea
                    id={key}
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={form[key]}
                    onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                  />
                ) : options ? (
                  <select
                    id={key}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={form[key]}
                    onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
                  >
                    <option value="">Not shown</option>
                    {options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <Input id={key} type={type} value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))} />
                )}
                {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
                {errors[key] && <p className="text-sm text-red-600">{errors[key]}</p>}
                {(STATUTORY as Field[]).includes(key) && changed(key as Statutory) && (
                  <div className="space-y-1 pt-1">
                    <Label htmlFor={`${key}Confirm`}>Re-type the {label.toLowerCase()} to confirm</Label>
                    <Input
                      id={`${key}Confirm`}
                      autoComplete="off"
                      onPaste={(e) => e.preventDefault()}
                      value={confirm[key as Statutory]}
                      onChange={(e) => setConfirm((p) => ({ ...p, [key]: e.target.value }))}
                    />
                    {errors[`${key as Statutory}Confirm`] && (
                      <p className="text-sm text-red-600">{errors[`${key as Statutory}Confirm`]}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save lender identity"}
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
