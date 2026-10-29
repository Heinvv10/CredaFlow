"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { RuleDef } from "@/lib/decisioning/types"
import { RuleRow } from "./RuleRow"
import { ScorecardEditor } from "./ScorecardEditor"
import { SimulationPanel } from "./SimulationPanel"
import { api, controlClass, type ChangeRow, type Overview, type RuleSetPayload } from "./types"

const newRule = (n: number): RuleDef => ({
  id: `rule-${n}`, name: `Rule ${n}`, outcome: "REFER", reasonCode: `RULE_${n}`,
  when: { all: [{ field: "bureauScore", op: "lt", value: 0 }] },
})

interface Props {
  overview: Overview
  initial: RuleSetPayload
  /** Set when editing a draft change request; absent for a new one. */
  request?: ChangeRow
  onDone: () => void
  onCancel: () => void
}

/** Form-based builder for one rule set version: scope, dates, rules, scorecard; saved as a draft change request and submitted for a second person's approval. */
export function RuleSetEditor({ overview, initial, request, onDone, onCancel }: Props) {
  const [payload, setPayload] = useState<RuleSetPayload>(initial)
  const [title, setTitle] = useState(request?.title ?? `Rule set: ${initial.name}`)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [saved, setSaved] = useState<string | null>(null)
  const patch = (p: Partial<RuleSetPayload>) => setPayload((cur) => ({ ...cur, ...p }))

  async function save(andSubmit: boolean) {
    setBusy(true)
    setProblems([])
    const saveRes = request
      ? await api<{ request: ChangeRow }>(`/api/maker-checker/${request.id}`, "PATCH", { title, payload })
      : await api<{ request: ChangeRow }>("/api/maker-checker", "POST", { kind: "DECISION_RULE_SET", title, payload })
    if (!saveRes.ok || !saveRes.data) {
      setBusy(false)
      setProblems(saveRes.problems.length > 0 ? saveRes.problems : [saveRes.error ?? "Could not save."])
      return
    }
    if (andSubmit) {
      const submitRes = await api(`/api/maker-checker/${saveRes.data.request.id}/submit`, "POST", {})
      if (!submitRes.ok) {
        setBusy(false)
        setProblems(submitRes.problems.length > 0 ? submitRes.problems : [submitRes.error ?? "Could not submit."])
        return
      }
    }
    setBusy(false)
    setSaved(andSubmit ? "Submitted: a second person must approve it before it can run." : "Draft saved.")
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{request ? "Edit draft rule set" : "New rule set version"}</CardTitle>
        <CardDescription>
          Nothing here takes effect until a different person approves it. Rules run in order; a knock-out declines, a refer rule or an amount above a cap sends the application to staff, and the scorecard grades the applicant.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="rs-name">Name</Label>
            <Input id="rs-name" value={payload.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rs-scope">Applies to</Label>
            <select id="rs-scope" className={`${controlClass} w-full`} value={payload.productId ?? ""} onChange={(e) => patch({ productId: e.target.value || null })}>
              <option value="">All products without their own set</option>
              {overview.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rs-date">Effective from</Label>
            <Input id="rs-date" type="date" value={payload.effectiveFrom} onChange={(e) => patch({ effectiveFrom: e.target.value })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={payload.challengerOnly} onChange={(e) => patch({ challengerOnly: e.target.checked })} />
          Challenger only: never decides as the live set; it can be named as the lender&apos;s challenger under Engine settings.
        </label>

        <section className="space-y-3" aria-label="Rules">
          <h3 className="font-semibold">Rules</h3>
          {payload.rules.map((rule, i) => (
            <RuleRow key={i} rule={rule} index={i} facts={overview.facts}
              onChange={(r) => patch({ rules: payload.rules.map((x, j) => (j === i ? r : x)) })}
              onRemove={() => patch({ rules: payload.rules.filter((_, j) => j !== i) })} />
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => patch({ rules: [...payload.rules, newRule(payload.rules.length + 1)] })}>Add rule</Button>
        </section>

        <section className="space-y-3" aria-label="Scorecard">
          <h3 className="font-semibold">Scorecard and risk grades</h3>
          <ScorecardEditor scorecard={payload.scorecard} facts={overview.facts} onChange={(scorecard) => patch({ scorecard })} />
        </section>

        <SimulationPanel source={{ draft: { productId: payload.productId, rules: payload.rules, scorecard: payload.scorecard } }} />

        <div className="space-y-1 md:w-1/2">
          <Label htmlFor="rs-title">Describe the change for the approver</Label>
          <Input id="rs-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        {problems.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        {saved && <p role="status" className="text-sm text-[var(--cf-success)]">{saved}</p>}
        <div className="flex gap-2">
          <Button type="button" disabled={busy} onClick={() => save(true)}>Submit for approval</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => save(false)}>Save draft</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Close</Button>
        </div>
      </CardContent>
    </Card>
  )
}
