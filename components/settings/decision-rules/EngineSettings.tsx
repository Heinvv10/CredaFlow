"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, controlClass, type ChangeRow, type EnginePayload, type Overview } from "./types"

const MODES: Record<EnginePayload["mode"], string> = {
  OFF: "Off: staff decide every application (default)",
  SHADOW: "Shadow: grade and record what the rules would decide, act on nothing",
  LIVE: "Live: decline, refer and approve automatically",
}
const CHANNELS = [["PORTAL", "Client portal (digital)"], ["STAFF", "Captured by staff"]] as const

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** The lender's engine settings. A change is a request a second person approves; the current settings stay in force until then. */
export function EngineSettings({ overview, onDone }: { overview: Overview; onDone: () => void }) {
  const [cfg, setCfg] = useState<EnginePayload>(overview.config)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [sent, setSent] = useState(false)
  const pending = overview.requests.find((r) => r.kind === "DECISION_ENGINE_CONFIG" && (r.status === "SUBMITTED" || r.status === "DRAFT"))
  const patch = (p: Partial<EnginePayload>) => setCfg((cur) => ({ ...cur, ...p }))

  async function submitChange() {
    setBusy(true)
    setProblems([])
    setSent(false)
    const created = await api<{ request: ChangeRow }>("/api/maker-checker", "POST", { kind: "DECISION_ENGINE_CONFIG", title: `Decision engine: ${cfg.mode.toLowerCase()}`, payload: cfg })
    const submitted = created.ok && created.data ? await api(`/api/maker-checker/${created.data.request.id}/submit`, "POST", {}) : created
    setBusy(false)
    if (!submitted.ok) {
      setProblems(submitted.problems.length > 0 ? submitted.problems : [submitted.error ?? "Could not submit."])
      return
    }
    setSent(true)
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision engine</CardTitle>
        <CardDescription>
          Which applications the rules may decide on their own. An automatic approval still goes through every check a person&apos;s approval does (KYC, bureau, affordability, screening, credit checks, compliance evidence); anything it cannot pass is referred to staff.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {pending && <p role="status" className="rounded-md bg-[var(--cf-bg-subtle)] p-3 text-sm">A change to these settings is {pending.status === "SUBMITTED" ? "waiting for approval" : "saved as a draft"} (see Approvals). The settings below show what is in force today.</p>}
        <fieldset className="space-y-2" disabled={!overview.canManage}>
          <legend className="text-sm font-semibold">Mode</legend>
          {(Object.keys(MODES) as EnginePayload["mode"][]).map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" checked={cfg.mode === mode} onChange={() => patch({ mode })} />{MODES[mode]}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2" disabled={!overview.canManage}>
          <legend className="text-sm font-semibold">Channels</legend>
          {CHANNELS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.channels.includes(value)} onChange={() => patch({ channels: toggle(cfg.channels, value) })} />{label}</label>
          ))}
        </fieldset>
        <fieldset className="space-y-2" disabled={!overview.canManage}>
          <legend className="text-sm font-semibold">Products</legend>
          {overview.products.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.productIds.includes(p.id)} onChange={() => patch({ productIds: toggle(cfg.productIds, p.id) })} />{p.name} ({p.code})</label>
          ))}
        </fieldset>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="eng-delegate">Approvals are booked under</Label>
            <select id="eng-delegate" className={`${controlClass} w-full`} disabled={!overview.canManage} value={cfg.delegateUserId ?? ""} onChange={(e) => patch({ delegateUserId: e.target.value || null })}>
              <option value="">Choose a staff user…</option>
              {overview.delegates.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email} ({u.role})</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="eng-repay">Repayment method on automatic approvals</Label>
            <select id="eng-repay" className={`${controlClass} w-full`} disabled={!overview.canManage} value={cfg.repaymentMethod} onChange={(e) => patch({ repaymentMethod: e.target.value as EnginePayload["repaymentMethod"] })}>
              <option value="EFT">EFT</option>
              <option value="DEBIT_ORDER">Debit order</option>
            </select>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="eng-chal">Challenger version</Label>
            <select id="eng-chal" className={`${controlClass} w-full`} disabled={!overview.canManage} value={cfg.challengerVersionId ?? ""} onChange={(e) => patch({ challengerVersionId: e.target.value || null })}>
              <option value="">None</option>
              {overview.versions.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.scopeKey === "ALL" ? "all products" : "one product"} v{v.version}{v.challengerOnly ? ", challenger only" : ""})</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="eng-pct">Share sent to the challenger (0 to 50%)</Label>
            <Input id="eng-pct" type="number" min={0} max={50} disabled={!overview.canManage} value={cfg.challengerPercent} onChange={(e) => patch({ challengerPercent: Number(e.target.value) })} />
          </div>
        </div>
        {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {sent && <p role="status" className="text-sm text-[var(--cf-success)]">Submitted: a second person must approve it before it applies.</p>}
        {overview.canManage && <Button type="button" disabled={busy} onClick={submitChange}>Submit for approval</Button>}
      </CardContent>
    </Card>
  )
}
