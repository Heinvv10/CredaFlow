"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLeaseAction } from "./lease-action"

export function LeaseTotalLossForm({ loanId }: { loanId: string }) {
  const [evidence, setEvidence] = useState("")
  const [insurance, setInsurance] = useState("0")
  const { busy, error, run } = useLeaseAction()
  return <details className="rounded-md border border-[var(--cf-border-subtle)] p-3">
    <summary className="cursor-pointer text-sm font-semibold">Record a total loss</summary>
    <form className="mt-3 space-y-3" onSubmit={(event) => {
      event.preventDefault()
      void run(`/api/asset-finance/leases/${loanId}/total-loss`, { evidence, insuranceProceedsCents: Math.round(Number(insurance) * 100) })
    }}>
      <p className="text-sm">A write-off ends the lease today. Arrears and the present value of remaining rentals are owed, without a penalty; insurer money is credited as a receipt.</p>
      <label className="block text-sm">Write-off and insurer payment evidence reference<Input required value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
      <label className="block text-sm">Insurance proceeds actually received (R)<Input required type="number" min="0" step="0.01" value={insurance} onChange={(e) => setInsurance(e.target.value)} /></label>
      <Button type="submit" size="sm" disabled={busy}>{busy ? "Recording…" : "Record write-off and end lease"}</Button>
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
    </form>
  </details>
}
