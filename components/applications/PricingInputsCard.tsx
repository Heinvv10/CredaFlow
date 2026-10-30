"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, controlClass } from "@/components/settings/decision-rules/types"

interface PricingInputs {
  inputs: { segment: string | null; channel: string | null; campaignCode: string | null }
  riskGradeRank: number | null
  options: { segments: string[]; channels: string[] }
  open: boolean
  price: { interestRatePm: number; baseRatePm: number; productVersion: number | null; rule: string | null; repayment: { frequency: string; structure: string } | null }
}

const pct = (decimal: number) => `${Math.round(decimal * 10_000) / 100}%`

/**
 * What the pricing rules are matched on for this application (segment, channel, campaign) and the price they give. Shown only for a
 * product under the product engine. The segments are the lender's configured ones and the channel is one of the fixed channels
 * (the system sets it when the application is created); whoever sets these does not also approve a loan priced on them.
 */
export function PricingInputsCard({ applicationId, onChanged }: { applicationId: string; onChanged?: () => void }) {
  const [data, setData] = useState<PricingInputs | null>(null)
  const [segment, setSegment] = useState("")
  const [channel, setChannel] = useState("")
  const [campaign, setCampaign] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  async function load() {
    const res = await api<PricingInputs>(`/api/applications/${applicationId}/pricing-inputs`, "GET")
    if (!res.ok || !res.data) return
    setData(res.data)
    setSegment(res.data.inputs.segment ?? "")
    setChannel(res.data.inputs.channel ?? "")
    setCampaign(res.data.inputs.campaignCode ?? "")
  }
  useEffect(() => { void load() }, [applicationId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || data.price.productVersion === null) return null

  async function save() {
    setBusy(true)
    setMessage(null)
    const res = await api(`/api/applications/${applicationId}/pricing-inputs`, "PUT", { segment: segment || null, channel: channel || null, campaignCode: campaign.trim() || null })
    setBusy(false)
    if (!res.ok) {
      setMessage({ kind: "error", text: res.error ?? "Could not save." })
      return
    }
    setMessage({ kind: "ok", text: "Saved. The price below is what approval will use." })
    await load()
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
            <select id="pi-channel" className={`${controlClass} w-full`} value={channel} disabled={!data.open} onChange={(e) => setChannel(e.target.value)}>
              <option value="">None</option>{data.options.channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pi-campaign">Campaign code</Label>
            <Input id="pi-campaign" value={campaign} disabled={!data.open} onChange={(e) => setCampaign(e.target.value.toUpperCase())} />
          </div>
        </div>
        {message && <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-[var(--cf-danger)]" : "text-[var(--cf-success)]"}`}>{message.text}</p>}
        {data.open ? <Button type="button" size="sm" disabled={busy} onClick={save}>Save pricing inputs</Button> : <p className="text-sm text-[var(--cf-text-muted)]">The application is decided: its price is fixed.</p>}
      </CardContent>
    </Card>
  )
}
