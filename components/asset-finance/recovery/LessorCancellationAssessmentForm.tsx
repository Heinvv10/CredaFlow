"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CPA_CANCELLATION_FACTORS } from "@/lib/asset-finance/cpa-cancellation-assessment"
import { useLegalAction } from "./legal-matter-client"

/** Assessment approves the net cancellation charge; it does not duplicate goods proceeds or vendor expenses. */
export function LessorCancellationAssessmentForm({ url }: { url: string }) {
  const [amount, setAmount] = useState("")
  const [factors, setFactors] = useState<Record<string, string>>({})
  const [rationale, setRationale] = useState("")
  const [fairnessReason, setFairness] = useState("")
  const { busy, error, runAll } = useLegalAction()
  return <form className="space-y-3" onSubmit={(event) => {
    event.preventDefault()
    void runAll([{ url, body: { assessment: { assessedChargeCents: Math.round(Number(amount) * 100), factors, rationale, fairnessReason } } }])
  }}>
    <p className="text-sm">CPA lessor breach cancellation: approve the reasonable final net cancellation charge under clause 9.10 and CPA section 48. This includes VAT and actual collectible recovery costs after the single net goods-proceeds credit; arrears remain separate. The financial formula is a ceiling. A lower amount or full waiver records a noncash concession; actual expenses and bank cash stay unchanged.</p>
    <label className="block text-sm">Approved final net charge including VAT (R)<Input required type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
    {CPA_CANCELLATION_FACTORS.map(([key, label]) => <label key={key} className="block text-sm">{label}<Input required value={factors[key] ?? ""} onChange={(event) => setFactors({ ...factors, [key]: event.target.value })} /></label>)}
    <label className="block text-sm">Why this amount is reasonable, including any reduction<Input required value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
    <label className="block text-sm">Why the breach-cancellation charge is fair and proportionate<Input required value={fairnessReason} onChange={(event) => setFairness(event.target.value)} /></label>
    {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
    <Button size="sm" type="submit" disabled={busy}>{busy ? "Assessing…" : "Approve assessment and apply actual proceeds"}</Button>
  </form>
}
