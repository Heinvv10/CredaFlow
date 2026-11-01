"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, controlClass } from "@/components/settings/decision-rules/types"
import { PRODUCT_TYPE_HINT, PRODUCT_TYPE_LABELS, type ProductTypeName } from "@/lib/product-config/product-kind"

interface Facts {
  employerName: string | null
  payrollNumber: string | null
  businessName: string | null
  businessRegistrationNumber: string | null
  annualTurnoverCents: number | null
  borrowerGroupId: string | null
}
interface Loaded {
  productType: ProductTypeName
  facts: Facts
  groups: Array<{ id: string; name: string }>
  open: boolean
}

function Text({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} /></div>
}

/** What a salary-backed, SME or group application must carry before it can be approved. Whoever sets it does not approve the application. */
export function ProductFactsCard({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<Loaded | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const path = `/api/applications/${applicationId}/product-facts`

  useEffect(() => {
    let live = true
    void api<Loaded>(path, "GET").then((res) => {
      if (!live || !res.ok || !res.data) return
      const f = res.data.facts
      setData(res.data)
      setForm({
        employerName: f.employerName ?? "", payrollNumber: f.payrollNumber ?? "", businessName: f.businessName ?? "", businessRegistrationNumber: f.businessRegistrationNumber ?? "",
        turnover: f.annualTurnoverCents !== null ? String(f.annualTurnoverCents / 100) : "", borrowerGroupId: f.borrowerGroupId ?? "",
      })
    })
    return () => { live = false }
  }, [path])

  if (!data) return null
  const set = (key: string) => (value: string) => setForm((cur) => ({ ...cur, [key]: value }))
  const closed = !data.open

  async function save() {
    setBusy(true)
    setMessage(null)
    const { turnover, ...rest } = form
    const res = await api(path, "PUT", { ...rest, annualTurnoverCents: turnover?.trim() ? Math.round(Number(turnover) * 100) : null })
    setBusy(false)
    setMessage(res.ok ? { kind: "ok", text: "Saved. Someone else approves this application." } : { kind: "error", text: res.error ?? "Could not save." })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{PRODUCT_TYPE_LABELS[data.productType]} details</CardTitle>
        <CardDescription>{PRODUCT_TYPE_HINT[data.productType]}</CardDescription>
      </CardHeader>
      {data.productType !== "REVOLVING" && (
        <CardContent className="space-y-3">
          <div className="grid gap-3">
            {data.productType === "SALARY_BACKED" && <>
              <Text id="pf-employer" label="Employer" value={form.employerName ?? ""} onChange={set("employerName")} disabled={closed} />
              <Text id="pf-payroll" label="Payroll number" value={form.payrollNumber ?? ""} onChange={set("payrollNumber")} disabled={closed} />
            </>}
            {data.productType === "SME" && <>
              <Text id="pf-business" label="Business name" value={form.businessName ?? ""} onChange={set("businessName")} disabled={closed} />
              <Text id="pf-reg" label="Registration number" value={form.businessRegistrationNumber ?? ""} onChange={set("businessRegistrationNumber")} disabled={closed} />
              <Text id="pf-turnover" label="Annual turnover" value={form.turnover ?? ""} onChange={set("turnover")} disabled={closed} />
            </>}
            {data.productType === "GROUP" && (
              <div className="space-y-1">
                <Label htmlFor="pf-group">Lending group</Label>
                <select id="pf-group" className={`${controlClass} w-full`} disabled={closed} value={form.borrowerGroupId ?? ""} onChange={(e) => set("borrowerGroupId")(e.target.value)}>
                  <option value="">Choose a group</option>{data.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {message && <p role={message.kind === "ok" ? "status" : "alert"} className={`text-sm ${message.kind === "ok" ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>{message.text}</p>}
          {!closed && <Button size="sm" disabled={busy} onClick={save}>Save details</Button>}
        </CardContent>
      )}
    </Card>
  )
}
