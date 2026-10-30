"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { api, controlClass } from "@/components/settings/decision-rules/types"

interface PricingInputs {
  inputs: { segment: string | null; channel: string | null; campaignCode: string | null }
  riskGradeRank: number | null
  options: { segments: string[]; campaigns: string[] }
  open: boolean
  price: { interestRatePm: number; baseRatePm: number; productVersion: number | null; rule: string | null; repayment: { frequency: string; structure: string } | null }
}

const pct = (decimal: number) => `${Math.round(decimal * 10_000) / 100}%`

/**
 * What the pricing rules are matched on for this application (segment, channel, campaign) and the price they give. Shown only for a
 * product under the product engine. The segments are the lender's configured ones and the campaign one of the lender's configured codes, and the channel is shown, not chosen
 * (the system sets it when the application is created); whoever sets these does not also approve a loan priced on them.
 */
export function PricingInputsCard({ applicationId, onChanged }: { applicationId: string; onChanged?: () => void }) {
  const [data, setData] = useState<PricingInputs | null>(null)
  const [segment, setSegment] = useState("")
  const [campaign, setCampaign] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const apply = (next: PricingInputs) => {
    setData(next)
    setSegment(next.inputs.segment ?? "")
    setCampaign(next.inputs.campaignCode ?? "")
  }
  const path = `/api/applications/${applicationId}/pricing-inputs`
  useEffect(() => {
    let live = true
    void api<PricingInputs>(path, "GET").then((res) => { if (live && res.ok && res.data) apply(res.data) })
    return () => { live = false }
  }, [path])

  if (!data || data.price.productVersion === null) return null

  async function save() {
    setBusy(true)
    setMessage(null)
    const res = await api(path, "PUT", { segment: segment || null, campaignCode: campaign || null })
    setBusy(false)
    if (!res.ok) {
      setMessage({ kind: "error", text: res.error ?? "Could not save." })
      return
    }
    setMessage({ kind: "ok", text: "Saved. The price below is what approval will use." })
    const fresh = await api<PricingInputs>(path, "GET")
    if (fresh.ok && fresh.data) apply(fresh.data)
    onChanged?.()
  }

  const { price } = data
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing</CardTitle>
        <CardDescription>
          Priced on product version {price.productVersion}: {pct(price.interestRatePm)} a month{price.rule ? `, by the rule "${price.rule}" (the product's own rate is ${pct(price.baseRatePm)})` : ""}.
          {price.repayment ? ` Repayment: ${price.repayment.frequency.toLowerCase()}, ${price.repayment.structure.toLowerCase().replace("_", "-")}.` : ""}
          {data.riskGradeRank === null ? " This application has no risk grade, so a rule that names one does not apply." : ` Risk grade rank ${data.riskGradeRank}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="pi-segment">Customer segment</Label>
            <select id="pi-segment" className={`${controlClass} w-full`} value={segment} disabled={!data.open} onChange={(e) => setSegment(e.target.value)}>
              <option value="">None</option>{data.options.segments.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pi-channel">Channel</Label>
            <p id="pi-channel" className="flex h-9 items-center text-sm text-[var(--cf-text)]">{data.inputs.channel ?? "Not recorded"}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pi-campaign">Campaign</Label>
            <select id="pi-campaign" className={`${controlClass} w-full`} value={campaign} disabled={!data.open} onChange={(e) => setCampaign(e.target.value)}>
              <option value="">None</option>{data.options.campaigns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {message && <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{message.text}</p>}
        {data.open ? <Button type="button" size="sm" disabled={busy} onClick={save}>Save pricing inputs</Button> : <p className="text-sm text-[var(--cf-text-muted)]">The application is decided: its price is fixed.</p>}
      </CardContent>
    </Card>
  )
}
