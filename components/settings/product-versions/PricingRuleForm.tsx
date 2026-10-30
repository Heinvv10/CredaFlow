"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, controlClass, type ChangeRow, type EngineOverview } from "./types"

const nullable = (text: string) => (text.trim() === "" ? null : text.trim())

/** Proposes a pricing rule: the conditions it needs (blank = any) and the rate it sets; saved and submitted for a second person's approval. */
export function PricingRuleForm({ overview, onDone, onCancel }: { overview: EngineOverview; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    productId: "", name: "", segment: "", channel: "", rankMin: "", rankMax: "", campaign: "", validFrom: overview.today, validTo: "", priority: "0", mode: "SET" as "SET" | "ADD", ratePct: "", feePct: "",
  })
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [done, setDone] = useState<string | null>(null)
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }))
  const field = (key: keyof typeof f, id: string, label: string, type?: string) => (
    <div className="space-y-1"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} value={f[key]} onChange={(e) => set({ [key]: e.target.value })} /></div>
  )

  async function submit() {
    setBusy(true)
    setProblems([])
    const rank = (t: string) => (t.trim() === "" ? null : Number(t))
    const payload = {
      action: "CREATE",
      rule: {
        productId: nullable(f.productId), name: f.name.trim(), segment: nullable(f.segment), channel: nullable(f.channel), riskRankMin: rank(f.rankMin), riskRankMax: rank(f.rankMax),
        campaignCode: nullable(f.campaign), validFrom: f.validFrom, validTo: nullable(f.validTo), priority: Number(f.priority),
        rate: { mode: f.mode, value: Math.round(Number(f.ratePct) * 100) / 10_000 }, initiationFeePct: f.feePct.trim() === "" ? null : Math.round(Number(f.feePct) * 100) / 10_000,
      },
    }
    const created = await api<{ request: ChangeRow }>("/api/maker-checker", "POST", { kind: "PRODUCT_PRICING_RULE", title: `Pricing rule: ${f.name.trim()}`, payload })
    if (!created.ok || !created.data) {
      setBusy(false)
      setProblems(created.problems.length > 0 ? created.problems : [created.error ?? "Could not save."])
      return
    }
    const submitted = await api(`/api/maker-checker/${created.data.request.id}/submit`, "POST", {})
    setBusy(false)
    if (!submitted.ok) {
      setProblems(submitted.problems.length > 0 ? submitted.problems : [submitted.error ?? "Could not submit."])
      return
    }
    setDone("Submitted. A second person approves it under Approvals.")
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New pricing rule</CardTitle>
        <CardDescription>
          One rule prices an application: the most specific one that matches (the most conditions named), then the higher priority. A condition left blank matches anything.
          The risk grade is a rank: 0 is the best band of the scorecard, so ranks 0 to 1 are its two best bands.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {field("name", "pr-name", "Name")}
          <div className="space-y-1">
            <Label htmlFor="pr-product">Product</Label>
            <select id="pr-product" className={`${controlClass} w-full`} value={f.productId} onChange={(e) => set({ productId: e.target.value })}>
              <option value="">Every product</option>{overview.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
            </select>
          </div>
          {field("priority", "pr-priority", "Priority (0 to 1000)")}
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          {field("segment", "pr-segment", "Customer segment")}{field("channel", "pr-channel", "Channel")}{field("campaign", "pr-campaign", "Campaign code")}
          {field("rankMin", "pr-rankmin", "Best grade rank")}{field("rankMax", "pr-rankmax", "Worst grade rank")}
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          {field("validFrom", "pr-from", "Valid from", "date")}{field("validTo", "pr-to", "Valid to (blank = open)", "date")}
          <div className="space-y-1">
            <Label htmlFor="pr-mode">Rate</Label>
            <select id="pr-mode" className={`${controlClass} w-full`} value={f.mode} onChange={(e) => set({ mode: e.target.value as "SET" | "ADD" })}>
              <option value="SET">Set the rate to</option><option value="ADD">Add to the product rate</option>
            </select>
          </div>
          {field("ratePct", "pr-rate", "% a month (a discount is negative)")}
        </div>
        <div className="md:w-1/4">{field("feePct", "pr-fee", "Initiation fee % (blank = product's)")}</div>
        {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {done && <p role="status" className="text-sm text-[var(--cf-success)]">{done}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy || done !== null} onClick={submit}>Submit for approval</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Close</Button>
        </div>
      </CardContent>
    </Card>
  )
}
