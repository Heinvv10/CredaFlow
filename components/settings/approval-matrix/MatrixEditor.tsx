"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NumberField, OptionalNumberField } from "@/components/settings/decision-rules/fields"
import { api, controlClass, type ChangeRow } from "@/components/settings/decision-rules/types"
import { formatMoneyWhole } from "@/lib/jurisdiction/money"
import type { Currency } from "@/lib/jurisdiction/profiles"
import type { ApproverRole, MatrixLevel, MatrixPayload, MatrixRule } from "@/lib/approval/types"

const ROLES: ApproverRole[] = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"]

interface Props {
  currency: Currency
  products: Array<{ id: string; name: string; code: string }>
  branches: Array<{ id: string; name: string }>
  initial: MatrixPayload
  request?: ChangeRow
  onCancel: () => void
  onDone: () => void
}

const slug = (n: number) => `rule-${n}`
const toggle = (list: string[] | undefined, id: string) => ((list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id])

/** The form for a new version of the approval matrix: levels, rules and their conditions. Nothing applies until a different person approves it. */
export function MatrixEditor({ currency, products, branches, initial, request, onCancel, onDone }: Props) {
  const [payload, setPayload] = useState<MatrixPayload>(initial)
  const [title, setTitle] = useState(request?.title ?? `Approval matrix: ${initial.name}`)
  const [requestId, setRequestId] = useState<string | null>(request?.id ?? null)
  const [problems, setProblems] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const patch = (p: Partial<MatrixPayload>) => { setPayload((c) => ({ ...c, ...p })); setSaved(null) }
  const setLevel = (i: number, l: Partial<MatrixLevel>) => patch({ levels: payload.levels.map((x, j) => (j === i ? { ...x, ...l } : x)) })
  const setRule = (i: number, r: Partial<MatrixRule>) => patch({ rules: payload.rules.map((x, j) => (j === i ? { ...x, ...r } : x)) })
  const setWhen = (i: number, w: Partial<MatrixRule["when"]>) => setRule(i, { when: { ...payload.rules[i].when, ...w } })
  const levelCount = payload.levels.length

  async function save(andSubmit: boolean) {
    setBusy(true)
    setProblems([])
    const saveRes = requestId
      ? await api<{ request: ChangeRow }>(`/api/maker-checker/${requestId}`, "PATCH", { title, payload })
      : await api<{ request: ChangeRow }>("/api/maker-checker", "POST", { kind: "APPROVAL_MATRIX", title, payload })
    if (!saveRes.ok || !saveRes.data) {
      setBusy(false)
      setProblems(saveRes.problems.length > 0 ? saveRes.problems : [saveRes.error ?? "Could not save."])
      return
    }
    setRequestId(saveRes.data.request.id)
    if (andSubmit) {
      const submitRes = await api(`/api/maker-checker/${saveRes.data.request.id}/submit`, "POST", {})
      if (!submitRes.ok) {
        setBusy(false)
        setProblems(submitRes.problems.length > 0 ? submitRes.problems : [submitRes.error ?? "Could not submit."])
        return
      }
    }
    setBusy(false)
    setSaved(andSubmit ? "Submitted: a second person must approve it before it applies." : "Draft saved.")
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{request ? "Edit draft approval matrix" : "New approval matrix version"}</CardTitle>
        <CardDescription>
          Levels approve in order, each by a different person; the rules say how many levels an application needs, by amount, product, risk grade and branch. The most demanding matching rule applies.
          A change that lets some application be approved with no staff approval, or switches the matrix off, needs a Super Admin to approve it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-1 md:col-span-2"><Label htmlFor="am-name">Name</Label><Input id="am-name" value={payload.name} onChange={(e) => patch({ name: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="am-date">Effective from</Label><Input id="am-date" type="date" value={payload.effectiveFrom} onChange={(e) => patch({ effectiveFrom: e.target.value })} /></div>
          <div className="space-y-1">
            <Label htmlFor="am-default">Levels when no rule matches</Label>
            <NumberField id="am-default" label="Levels when no rule matches" min={0} max={levelCount} value={payload.defaultRequiredLevels} onChange={(n) => patch({ defaultRequiredLevels: Math.trunc(n) })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={payload.enabled} onChange={() => patch({ enabled: !payload.enabled })} />
          Matrix on (off returns the lender to the single-approver flow)
        </label>

        <section className="space-y-3" aria-label="Levels">
          <h3 className="font-semibold">Levels</h3>
          {payload.levels.map((level, i) => (
            <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--cf-border-subtle)] p-3">
              <span className="w-16 text-sm font-semibold">Level {level.level}</span>
              <div className="space-y-1"><Label htmlFor={`lv-name-${i}`}>Name</Label><Input id={`lv-name-${i}`} className="w-52" value={level.name} onChange={(e) => setLevel(i, { name: e.target.value })} /></div>
              <div className="space-y-1">
                <Label htmlFor={`lv-role-${i}`}>Role that holds it</Label>
                <select id={`lv-role-${i}`} className={controlClass} value={level.role} onChange={(e) => setLevel(i, { role: e.target.value as ApproverRole })}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
              </div>
              <div className="space-y-1"><Label htmlFor={`lv-sla-${i}`}>Turnaround (hours)</Label><NumberField id={`lv-sla-${i}`} label="Turnaround hours" className="w-24" min={1} max={720} value={level.slaHours} onChange={(n) => setLevel(i, { slaHours: Math.trunc(n) })} /></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={level.committee} onChange={() => setLevel(i, { committee: !level.committee })} />Credit committee</label>
              {i === levelCount - 1 && levelCount > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => patch({ levels: payload.levels.slice(0, -1), rules: payload.rules.map((r) => ({ ...r, requiredLevels: Math.min(r.requiredLevels, levelCount - 1) })), defaultRequiredLevels: Math.min(payload.defaultRequiredLevels, levelCount - 1) })}>Remove level</Button>}
            </div>
          ))}
          {levelCount < 5 && <Button type="button" variant="outline" size="sm" onClick={() => patch({ levels: [...payload.levels, { level: levelCount + 1, name: `Level ${levelCount + 1}`, role: payload.levels[levelCount - 1]?.role ?? "ADMIN", slaHours: 24, committee: false }] })}>Add level</Button>}
        </section>

        <section className="space-y-3" aria-label="Rules">
          <h3 className="font-semibold">Rules</h3>
          {payload.rules.map((rule, i) => (
            <fieldset key={i} className="space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-3">
              <legend className="px-1 text-sm font-semibold">{rule.name || `Rule ${i + 1}`}</legend>
              <div className="grid gap-3 md:grid-cols-4">
                <div className="space-y-1 md:col-span-2"><Label htmlFor={`r-name-${i}`}>Name</Label><Input id={`r-name-${i}`} value={rule.name} onChange={(e) => setRule(i, { name: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`r-min-${i}`}>Amount from ({currency})</Label><OptionalNumberField label="Amount from" className="w-full" value={rule.when.amountMinCents == null ? undefined : rule.when.amountMinCents / 100} onChange={(v) => setWhen(i, { amountMinCents: v === undefined ? null : Math.round(v * 100) })} /></div>
                <div className="space-y-1"><Label htmlFor={`r-max-${i}`}>Amount up to ({currency})</Label><OptionalNumberField label="Amount up to" className="w-full" value={rule.when.amountMaxCents == null ? undefined : rule.when.amountMaxCents / 100} onChange={(v) => setWhen(i, { amountMaxCents: v === undefined ? null : Math.round(v * 100) })} /></div>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="space-y-1"><Label>Products (none ticked: all)</Label>{products.map((p) => <label key={p.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(rule.when.productIds ?? []).includes(p.id)} onChange={() => setWhen(i, { productIds: toggle(rule.when.productIds, p.id) })} />{p.name} ({p.code})</label>)}</div>
                <div className="space-y-1"><Label>Branches (none ticked: all)</Label>{branches.length === 0 ? <p className="text-xs text-[var(--cf-text-muted)]">No branches set up.</p> : branches.map((b) => <label key={b.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(rule.when.branchIds ?? []).includes(b.id)} onChange={() => setWhen(i, { branchIds: toggle(rule.when.branchIds, b.id) })} />{b.name}</label>)}</div>
                <div className="space-y-2">
                  <div className="space-y-1"><Label htmlFor={`r-risk-${i}`}>Risk grade rank this or worse (0 = best band)</Label><OptionalNumberField label="Risk grade rank" className="w-full" value={rule.when.riskGradeRankMin ?? undefined} onChange={(v) => setWhen(i, { riskGradeRankMin: v === undefined ? null : Math.trunc(v) })} /></div>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.when.ungraded === true} onChange={() => setWhen(i, { ungraded: !rule.when.ungraded })} />Also applications with no risk grade</label>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor={`r-levels-${i}`}>Levels needed</Label>
                  <select id={`r-levels-${i}`} className={controlClass} value={rule.requiredLevels} onChange={(e) => setRule(i, { requiredLevels: Number(e.target.value) })}>
                    {Array.from({ length: levelCount + 1 }, (_, n) => <option key={n} value={n}>{n === 0 ? "0 (no staff approval: the decision engine may approve)" : `${n} (${payload.levels[n - 1]?.name ?? ""})`}</option>)}
                  </select>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => patch({ rules: payload.rules.filter((_, j) => j !== i) })}>Remove rule</Button>
              </div>
            </fieldset>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => patch({ rules: [...payload.rules, { id: slug(payload.rules.length + 1), name: `Rule ${payload.rules.length + 1}`, when: {}, requiredLevels: Math.min(2, levelCount) }] })}>Add rule</Button>
          {payload.rules.some((r) => r.when.amountMinCents != null) && <p className="text-xs text-[var(--cf-text-muted)]">Amounts are tested as the principal applied for, for example {formatMoneyWhole(10_000, currency)}.</p>}
        </section>

        <div className="space-y-1 md:w-2/3"><Label htmlFor="am-title">Describe the change for the approver</Label><Input id="am-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {saved && <p role="status" className="text-sm text-[var(--cf-success)]">{saved}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy} onClick={() => save(true)}>Submit for approval</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => save(false)}>Save draft</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Close</Button>
        </div>
      </CardContent>
    </Card>
  )
}
