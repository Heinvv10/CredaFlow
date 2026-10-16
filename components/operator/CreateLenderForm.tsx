"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type Props = {
  features: Array<{ key: string; on: boolean }>
  identityFields: string[]
  statutoryFields: string[]
  defaultColours: Record<string, string>
}

const LABEL: Record<string, string> = {
  legalName: "Legal name", brandName: "Brand name", ncrNumber: "NCR number", fscaNumber: "FSP number (optional)",
  companyRegNumber: "Company registration number", registeredOffice: "Registered office (one address line per line)", publicEmail: "Public email",
  publicPhone: "Public phone", publicWhatsapp: "Public WhatsApp", collectionsEmail: "Collections email",
  collectionsPhone: "Collections phone", collectionsPhoneSecondary: "Collections phone (second)", brandTagline: "Tagline",
  ncrRegistrationDate: "NCR registration date (YYYY-MM-DD)", fscaAuthorisationDate: "FSP authorisation date (YYYY-MM-DD)",
  ncrStatus: "NCR status", headOfficeCity: "Head office city",
  primaryColor: "Primary colour", secondaryColor: "Secondary colour", darkColor: "Dark colour",
  lms: "Loans", crm: "CRM", ims: "Insurance", bureauSubmission: "Bureau submission", marketing: "Marketing", portal: "Client portal", reports: "Reports",
}

const label = (k: string) => LABEL[k] ?? k

function Field({ id, name, value, onChange, multiline = false }: { id: string; name: string; value: string; onChange: (v: string) => void; multiline?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-[var(--cf-text-secondary)]">{name}</label>
      {multiline
        ? <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
        : <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  )
}

/** The lender provisioning form; the server (lib/operator/console/provision.ts) is the validator. */
export function CreateLenderForm({ features, identityFields, statutoryFields, defaultColours }: Props) {
  const router = useRouter()
  const [base, setBase] = useState({ slug: "", name: "", domain: "" })
  const [colours, setColours] = useState<Record<string, string>>(defaultColours)
  const [flags, setFlags] = useState<Record<string, boolean>>(Object.fromEntries(features.map((f) => [f.key, f.on])))
  const [identity, setIdentity] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState<Record<string, string>>({})
  const [admin, setAdmin] = useState({ name: "", email: "" })
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErrors([])
    const blankToNull = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.trim() === "" ? null : v.trim()]))
    const res = await fetch("/api/operator/lenders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: base.slug.trim(), name: base.name.trim(), domain: base.domain.trim() || null,
        colours, features: flags, identity: blankToNull(identity), statutoryConfirm: blankToNull(confirm), admin,
      }),
    }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { tenantId?: string; inviteSent?: boolean; error?: string; errors?: string[] } | null
    setBusy(false)
    if (res?.ok && data?.tenantId) {
      router.push(`/operator/lenders/${data.tenantId}`)
      return
    }
    setErrors([data?.error ?? "Provisioning failed", ...(data?.errors ?? [])])
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Lender</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <Field id="lender-slug" name="Slug (lower-case, hyphens)" value={base.slug} onChange={(v) => setBase({ ...base, slug: v })} />
          <Field id="lender-name" name="Name" value={base.name} onChange={(v) => setBase({ ...base, name: v })} />
          <Field id="lender-domain" name="Custom domain (optional)" value={base.domain} onChange={(v) => setBase({ ...base, domain: v })} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Identity</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {identityFields.map((f) => (
            <Field
              key={f} id={`identity-${f}`} name={label(f)} value={identity[f] ?? ""} multiline={f === "registeredOffice"}
              onChange={(v) => setIdentity({ ...identity, [f]: v })}
            />
          ))}
          {statutoryFields.map((f) => (
            <Field key={`c-${f}`} id={`confirm-${f}`} name={`${label(f)} — type again`} value={confirm[f] ?? ""} onChange={(v) => setConfirm({ ...confirm, [f]: v })} />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Branding and modules</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            {Object.keys(colours).map((k) => (
              <Field key={k} id={`colour-${k}`} name={label(k)} value={colours[k]} onChange={(v) => setColours({ ...colours, [k]: v })} />
            ))}
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-[var(--cf-text-secondary)]">
            {features.map((f) => (
              <label key={f.key} className="inline-flex items-center gap-2">
                <input type="checkbox" checked={flags[f.key]} onChange={(e) => setFlags({ ...flags, [f.key]: e.target.checked })} />
                {label(f.key)}
              </label>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">First SUPER_ADMIN</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Field id="admin-name" name="Name" value={admin.name} onChange={(v) => setAdmin({ ...admin, name: v })} />
          <Field id="admin-email" name="Email (receives the set-password link)" value={admin.email} onChange={(v) => setAdmin({ ...admin, email: v })} />
        </CardContent>
      </Card>
      {errors.length > 0 ? (
        <ul role="alert" className="list-disc space-y-1 rounded-lg border border-[var(--cf-danger)] px-8 py-3 text-sm text-[var(--cf-danger)]">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      ) : null}
      <Button type="submit" disabled={busy}>{busy ? "Provisioning…" : "Create lender"}</Button>
    </form>
  )
}
