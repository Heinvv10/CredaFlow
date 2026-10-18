"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CPA_CANCELLATION_FACTORS } from "@/lib/asset-finance/cpa-cancellation-assessment"
import { useLeaseAction } from "./lease-action"

/** The cancellation already stands. Staff now document the charge, never a percentage penalty. */
export function LeaseCancellationAssessment({ url }: { url: string }) {
  const [assessed, setAssessed] = useState("")
  const [factors, setFactors] = useState<Record<string, string>>({})
  const [rationale, setRationale] = useState("")
  const [cancellationRightReason, setCancellationRightReason] = useState("")
  const [goods, setGoods] = useState("")
  const [costs, setCosts] = useState<{ description: string; amount: string; evidence: string; valuationNoOverlapEvidence: string }[]>([])
  const { busy, error, run } = useLeaseAction()
  return <form className="space-y-3" onSubmit={(event) => {
    event.preventDefault()
    void run(url, { assessment: { goodsValueCents: Math.round(Number(goods) * 100), reasonableAssessment: { assessedChargeCents: Math.round(Number(assessed) * 100), factors, rationale, cancellationRightReason }, costs: costs.map((c) => ({ description: c.description, amountCents: Math.round(Number(c.amount) * 100), evidence: c.evidence, valuationNoOverlapEvidence: c.valuationNoOverlapEvidence })) } })
  }}>
    <label className="block text-sm">Net realisable or re-let goods value (R)<Input type="number" min="0" step="0.01" value={goods} onChange={(e) => setGoods(e.target.value)} required /></label>
    {costs.map((cost, index) => <div className="grid gap-2 sm:grid-cols-3" key={index}>
      <label className="text-sm">Actual cost<Input placeholder="Recovery, refurbishment or re-letting" value={cost.description} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, description: e.target.value } : c))} /></label>
      <label className="text-sm">Amount (R)<Input type="number" min="0" step="0.01" value={cost.amount} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, amount: e.target.value } : c))} /></label>
      <label className="text-sm">Evidence reference<Input value={cost.evidence} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, evidence: e.target.value } : c))} /></label>
      <label className="text-sm sm:col-span-3">Evidence confirming this cost was not deducted from the net goods value<Input value={cost.valuationNoOverlapEvidence} required onChange={(e) => setCosts(costs.map((c, i) => i === index ? { ...c, valuationNoOverlapEvidence: e.target.value } : c))} /></label>
    </div>)}
    <p className="text-sm text-[var(--cf-text-muted)]">The financial formula is a ceiling. Consider every factor below, explaining any that do not apply. Reduce or waive the charge where necessary to preserve the consumer’s right to cancel.</p>
    {CPA_CANCELLATION_FACTORS.map(([key, label]) => <label className="block text-sm" key={key}>{label}<Input value={factors[key] ?? ""} onChange={(e) => setFactors({ ...factors, [key]: e.target.value })} required /></label>)}
    <label className="block text-sm">Reasonable charge after assessment (R; may be zero)<Input type="number" min="0" step="0.01" value={assessed} onChange={(e) => setAssessed(e.target.value)} required /></label>
    <label className="block text-sm">Why this amount is reasonable, including reductions<Input value={rationale} onChange={(e) => setRationale(e.target.value)} required /></label>
    <label className="block text-sm">Why the charge does not negate the consumer’s right to cancel<Input value={cancellationRightReason} onChange={(e) => setCancellationRightReason(e.target.value)} required /></label>
    <Button type="button" size="sm" variant="outline" onClick={() => setCosts([...costs, { description: "", amount: "", evidence: "", valuationNoOverlapEvidence: "" }])}>Add documented cost</Button>{" "}
    <Button type="submit" size="sm" disabled={busy}>{busy ? "Recording…" : "Record charge and issue invoice"}</Button>
    {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
  </form>
}
