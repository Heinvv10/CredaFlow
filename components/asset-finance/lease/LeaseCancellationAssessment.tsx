"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLeaseAction } from "./lease-action"

/** The cancellation already stands. Staff now document the charge, never a percentage penalty. */
export function LeaseCancellationAssessment({ url }: { url: string }) {
  const [goods, setGoods] = useState("")
  const [costs, setCosts] = useState<{ description: string; amount: string; evidence: string }[]>([])
  const { busy, error, run } = useLeaseAction()
  return <form className="space-y-3" onSubmit={(event) => {
    event.preventDefault()
    void run(url, { assessment: { goodsValueCents: Math.round(Number(goods) * 100), costs: costs.map((c) => ({ description: c.description, amountCents: Math.round(Number(c.amount) * 100), evidence: c.evidence })) } })
  }}>
    <label className="block text-sm">Net realisable or re-let goods value (R)<Input type="number" min="0" step="0.01" value={goods} onChange={(e) => setGoods(e.target.value)} required /></label>
    {costs.map((cost, index) => <div className="grid gap-2 sm:grid-cols-3" key={index}>
      <label className="text-sm">Actual cost<Input placeholder="Recovery, refurbishment or re-letting" value={cost.description} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, description: e.target.value } : c))} /></label>
      <label className="text-sm">Amount (R)<Input type="number" min="0" step="0.01" value={cost.amount} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, amount: e.target.value } : c))} /></label>
      <label className="text-sm">Evidence reference<Input value={cost.evidence} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, evidence: e.target.value } : c))} /></label>
    </div>)}
    <Button type="button" size="sm" variant="outline" onClick={() => setCosts([...costs, { description: "", amount: "", evidence: "" }])}>Add documented cost</Button>{" "}
    <Button type="submit" size="sm" disabled={busy}>{busy ? "Recording…" : "Record charge and issue invoice"}</Button>
    {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
  </form>
}
