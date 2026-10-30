"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NumberField } from "@/components/settings/decision-rules/fields"
import { api, controlClass } from "@/components/settings/decision-rules/types"
import { formatMoney } from "@/lib/jurisdiction/money"
import type { DelegationRow } from "@/lib/approval/overview"
import type { Currency } from "@/lib/jurisdiction/profiles"

interface Props {
  currency: Currency
  levels: Array<{ level: number; name: string }>
  staff: Array<{ id: string; name: string; role: string }>
  delegations: DelegationRow[]
  viewer: { id: string; canDelegate: boolean; canDelegateForOthers: boolean }
  onDone: () => void
}

const day = (iso: string) => iso.slice(0, 10)
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

function stateOf(d: DelegationRow, now = Date.now()): { label: string; variant: "success" | "neutral" | "warning" } {
  if (d.revokedAt) return { label: "Revoked", variant: "neutral" }
  if (Date.parse(d.validTo) < now) return { label: "Expired", variant: "neutral" }
  if (Date.parse(d.validFrom) > now) return { label: "Not yet", variant: "warning" }
  return { label: "In force", variant: "success" }
}

/** Delegated authority: who may approve at which level, up to what amount, between which dates. Never edited: it ends by revocation or expiry. */
export function DelegationsPanel({ currency, levels, staff, delegations, viewer, onDone }: Props) {
  const [delegateId, setDelegateId] = useState("")
  const [delegatorId, setDelegatorId] = useState(viewer.id)
  const [level, setLevel] = useState(levels[0]?.level ?? 1)
  const [amount, setAmount] = useState(5000)
  const [from, setFrom] = useState(inDays(0))
  const [to, setTo] = useState(inDays(14))
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function grant() {
    setBusy(true)
    setError(null)
    const res = await api("/api/approval/delegations", "POST", {
      delegateId, level, maxAmountCents: Math.round(amount * 100), reason,
      validFrom: `${from}T00:00:00.000Z`, validTo: `${to}T23:59:59.000Z`, ...(delegatorId !== viewer.id ? { delegatorId } : {}),
    })
    setBusy(false)
    if (!res.ok) return setError(res.problems[0] ?? res.error ?? "Could not record the delegation.")
    setReason("")
    onDone()
  }
  async function revoke(id: string) {
    setBusy(true)
    const res = await api(`/api/approval/delegations/${id}`, "DELETE")
    setBusy(false)
    if (!res.ok) return setError(res.error ?? "Could not revoke it.")
    onDone()
  }

  return (
    <div className="space-y-4">
      {viewer.canDelegate && (
        <Card>
          <CardHeader>
            <CardTitle>Delegate approval authority</CardTitle>
            <CardDescription>Pass your own level to someone else for an amount and a period (at most 90 days). It cannot exceed the level your role holds, and the delegate must be able to approve loans.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              {viewer.canDelegateForOthers && (
                <div className="space-y-1"><Label htmlFor="dg-from">On behalf of</Label>
                  <select id="dg-from" className={controlClass} value={delegatorId} onChange={(e) => setDelegatorId(e.target.value)}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}</select>
                </div>
              )}
              <div className="space-y-1"><Label htmlFor="dg-to">Delegate</Label>
                <select id="dg-to" className={controlClass} value={delegateId} onChange={(e) => setDelegateId(e.target.value)}><option value="">Choose…</option>{staff.filter((s) => s.id !== delegatorId && (delegatorId === viewer.id || s.id !== viewer.id)).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}</select>
              </div>
              <div className="space-y-1"><Label htmlFor="dg-level">Level</Label>
                <select id="dg-level" className={controlClass} value={level} onChange={(e) => setLevel(Number(e.target.value))}>{levels.map((l) => <option key={l.level} value={l.level}>{l.level}: {l.name}</option>)}</select>
              </div>
              <div className="space-y-1"><Label htmlFor="dg-amt">Up to ({currency})</Label><NumberField id="dg-amt" label="Largest amount" className="w-32" min={1} value={amount} onChange={setAmount} /></div>
              <div className="space-y-1"><Label htmlFor="dg-start">From</Label><Input id="dg-start" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="dg-end">Until</Label><Input id="dg-end" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="space-y-1 md:w-2/3"><Label htmlFor="dg-reason">Reason</Label><Input id="dg-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (10+ characters)" /></div>
            {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
            <Button type="button" disabled={busy || !delegateId} onClick={grant}>Delegate</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Delegations</CardTitle><CardDescription>Recorded and audited; ended ones stay on the list.</CardDescription></CardHeader>
        <CardContent>
          {delegations.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No delegations yet.</p> : (
            <ul className="divide-y divide-[var(--cf-border-subtle)]">
              {delegations.map((d) => {
                const state = stateOf(d)
                const mine = d.delegatorId === viewer.id || viewer.canDelegateForOthers
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <Badge variant={state.variant}>{state.label}</Badge>
                    <span><strong>{d.delegatorName}</strong> to <strong>{d.delegateName}</strong></span>
                    <span>level {d.level}, up to {formatMoney(d.maxAmountCents, currency)}</span>
                    <span className="text-[var(--cf-text-muted)]">{day(d.validFrom)} to {day(d.validTo)}</span>
                    <span className="text-[var(--cf-text-secondary)]">{d.reason}</span>
                    {state.label === "In force" && mine && <Button size="sm" variant="outline" disabled={busy} onClick={() => revoke(d.id)}>Revoke</Button>}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
