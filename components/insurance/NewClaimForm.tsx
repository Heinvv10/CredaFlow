"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR } from "@/lib/utils"
import { matchesEveryWord } from "@/lib/list-search"

export type ClaimablePolicy = {
  id: string
  policyNumber: string
  type: string
  sumAssured: number
  clientName: string
  clientEmail: string
}

const inp = "w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
const lbl = "block text-xs font-semibold text-gray-600 mb-1.5"

// The values the schema documents for InsuranceClaim.claimType.
const CLAIM_TYPES = [
  ["DEATH", "Death"],
  ["DISABILITY", "Disability"],
  ["MOTOR_ACCIDENT", "Motor accident"],
  ["THEFT", "Theft"],
  ["FIRE", "Fire"],
] as const

/** Search an active policy by client name (any words, any order), email or policy number, then lodge the claim. */
export function NewClaimForm({ policies }: { policies: ClaimablePolicy[] }) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [policy, setPolicy] = useState<ClaimablePolicy | null>(null)
  const [claimAmount, setClaimAmount] = useState("")
  const [claimType, setClaimType] = useState("")
  const [incidentDate, setIncidentDate] = useState("")
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const matches = search.trim().length < 2
    ? []
    : policies.filter((p) => matchesEveryWord(search, [p.clientName, p.clientEmail, p.policyNumber])).slice(0, 8)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!policy) return setError("Choose the policy the claim is made on.")
    const amount = Number(claimAmount)
    if (claimAmount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return setError("Enter the amount claimed.")
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/insurance/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policyId: policy.id,
          claimAmount: amount,
          claimType: claimType || null,
          incidentDate: incidentDate || null,
          fnolDate: new Date().toISOString().slice(0, 10),
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? "The claim could not be lodged.")
        return
      }
      router.push("/insurance/claims")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      {error && <div role="alert" className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{error}</div>}

      {policy ? (
        <div className="flex items-center justify-between p-3 border border-[#4F46E5]/30 rounded-xl">
          <div>
            <p className="font-semibold text-sm">{policy.clientName}</p>
            <p className="text-xs text-gray-500">{policy.policyNumber} · Cover {formatZAR(Math.round(policy.sumAssured * 100))}</p>
          </div>
          <button type="button" onClick={() => setPolicy(null)} className="text-xs text-gray-500 underline">Change</button>
        </div>
      ) : (
        <div>
          <label className={lbl} htmlFor="policy-search">Client or policy *</label>
          <input
            id="policy-search"
            className={inp}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Client name, email or policy number"
            autoComplete="off"
          />
          {matches.map((p) => (
            <button key={p.id} type="button" onClick={() => { setPolicy(p); setSearch("") }} className="w-full text-left px-3 py-2 hover:bg-gray-50 rounded-md">
              <p className="text-sm font-medium">{p.clientName}</p>
              <p className="text-xs text-gray-500">{p.policyNumber} · {p.type.replaceAll("_", " ").toLowerCase()}</p>
            </button>
          ))}
          {search.trim().length >= 2 && matches.length === 0 && (
            <p className="text-xs text-gray-500 mt-1">No active policy matches. Only active policies can be claimed on.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={lbl} htmlFor="claim-amount">Amount claimed (R) *</label>
          <input id="claim-amount" className={inp} type="number" inputMode="decimal" min="0.01" step="0.01" value={claimAmount} onChange={(e) => setClaimAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <label className={lbl} htmlFor="claim-type">Claim type</label>
          <select id="claim-type" className={`${inp} bg-white`} value={claimType} onChange={(e) => setClaimType(e.target.value)}>
            <option value="">— Select —</option>
            {CLAIM_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className={lbl} htmlFor="incident-date">Date of the event</label>
        <input id="incident-date" className={inp} type="date" value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} />
      </div>

      <div>
        <label className={lbl} htmlFor="claim-notes">Notes</label>
        <textarea id="claim-notes" className={`${inp} resize-none`} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <button type="submit" disabled={submitting} className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 bg-[#4F46E5] hover:bg-[#4338CA]">
        {submitting ? "Lodging..." : "Lodge claim"}
      </button>
    </form>
  )
}
