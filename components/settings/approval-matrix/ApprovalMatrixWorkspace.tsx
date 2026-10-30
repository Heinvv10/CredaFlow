"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChangeRequestsPanel } from "@/components/settings/decision-rules/ChangeRequestsPanel"
import type { ChangeRow } from "@/components/settings/decision-rules/types"
import { formatMoney } from "@/lib/jurisdiction/money"
import type { ApprovalMatrixOverview } from "@/lib/approval/overview"
import type { MatrixPayload, MatrixRule } from "@/lib/approval/types"
import { DelegationsPanel } from "./DelegationsPanel"
import { MatrixEditor } from "./MatrixEditor"

const today = () => new Date().toISOString().slice(0, 10)
const starter = (): MatrixPayload => ({
  name: "Approval matrix", enabled: true, effectiveFrom: today(), defaultRequiredLevels: 1,
  levels: [
    { level: 1, name: "Loan administrator", role: "LOAN_ADMIN", slaHours: 24, committee: false },
    { level: 2, name: "Branch manager", role: "BRANCH_MANAGER", slaHours: 24, committee: false },
  ],
  rules: [],
})

function describeWhen(rule: MatrixRule, o: ApprovalMatrixOverview): string {
  const w = rule.when
  const parts: string[] = []
  if (w.amountMinCents != null || w.amountMaxCents != null) parts.push(`amount ${w.amountMinCents != null ? `from ${formatMoney(w.amountMinCents, o.currency)}` : ""}${w.amountMaxCents != null ? ` up to ${formatMoney(w.amountMaxCents, o.currency)}` : ""}`.trim())
  if (w.productIds?.length) parts.push(`product ${w.productIds.map((id) => o.products.find((p) => p.id === id)?.name ?? id).join(", ")}`)
  if (w.branchIds?.length) parts.push(`branch ${w.branchIds.map((id) => o.branches.find((b) => b.id === id)?.name ?? id).join(", ")}`)
  if (w.riskGradeRankMin != null) parts.push(`risk rank ${w.riskGradeRankMin} or worse${w.ungraded ? " or ungraded" : ""}`)
  else if (w.ungraded) parts.push("ungraded")
  return parts.length === 0 ? "every application" : parts.join(" and ")
}

/** The approval matrix settings: the version in force, a form for the next, pending approvals, delegated authority and the history. */
export function ApprovalMatrixWorkspace({ overview }: { overview: ApprovalMatrixOverview }) {
  const router = useRouter()
  const [editing, setEditing] = useState<{ initial: MatrixPayload; request?: ChangeRow } | null>(null)
  const [tab, setTab] = useState("matrix")
  const refresh = () => router.refresh()
  const waiting = overview.requests.filter((r) => r.status === "SUBMITTED" || r.status === "DRAFT").length
  const current = overview.inForce

  if (editing) {
    return <MatrixEditor currency={overview.currency} products={overview.products} branches={overview.branches} initial={editing.initial} request={editing.request as never} onCancel={() => setEditing(null)} onDone={refresh} />
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="matrix">Matrix</TabsTrigger>
        <TabsTrigger value="approvals">Approvals{waiting > 0 ? ` (${waiting})` : ""}</TabsTrigger>
        <TabsTrigger value="delegations">Delegations</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>
      <TabsContent value="matrix" className="space-y-4">
        {overview.viewer.canManage && <Button onClick={() => setEditing({ initial: current ? { ...current.payload, effectiveFrom: today() } : starter() })}>{current ? "New version from this" : "Set up the approval matrix"}</Button>}
        {!current ? (
          <Card><CardHeader><CardTitle>No approval matrix in force</CardTitle><CardDescription>Applications are approved by one person with the approve permission, as before. A matrix adds levels by amount, product, risk grade and branch.</CardDescription></CardHeader></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{current.payload.name} <Badge variant="success">v{current.version}</Badge></CardTitle>
              <CardDescription>In force. Applications no rule matches need {current.payload.defaultRequiredLevels} level{current.payload.defaultRequiredLevels === 1 ? "" : "s"}.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <ol className="space-y-1">
                {current.payload.levels.map((l) => (
                  <li key={l.level}><strong>Level {l.level}: {l.name}</strong> held by {l.role}, {l.slaHours} h turnaround{l.committee ? ", the credit committee's level" : ""}</li>
                ))}
              </ol>
              {current.payload.rules.length > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="text-xs uppercase text-[var(--cf-text-muted)]"><th className="py-1">Rule</th><th>Applies to</th><th>Levels needed</th></tr></thead>
                  <tbody>{current.payload.rules.map((r) => <tr key={r.id} className="border-t border-[var(--cf-border-subtle)]"><td className="py-1 pr-3 font-medium">{r.name}</td><td className="pr-3">{describeWhen(r, overview)}</td><td>{r.requiredLevels === 0 ? "0 (the decision engine may approve)" : r.requiredLevels}</td></tr>)}</tbody>
                </table>
              )}
            </CardContent>
          </Card>
        )}
      </TabsContent>
      <TabsContent value="approvals">
        <ChangeRequestsPanel requests={overview.requests as never} onEdit={(row) => setEditing({ initial: row.payload as MatrixPayload, request: row })} onDone={refresh} />
      </TabsContent>
      <TabsContent value="delegations">
        <DelegationsPanel currency={overview.currency} levels={(current?.payload.levels ?? []).map((l) => ({ level: l.level, name: l.name }))} staff={overview.staff} delegations={overview.delegations} viewer={overview.viewer} onDone={refresh} />
      </TabsContent>
      <TabsContent value="history">
        <Card>
          <CardHeader><CardTitle>Versions</CardTitle><CardDescription>Each approved change is a new version; none is edited.</CardDescription></CardHeader>
          <CardContent>
            {overview.versions.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">None yet.</p> : (
              <ul className="divide-y divide-[var(--cf-border-subtle)] text-sm">
                {overview.versions.map((v) => <li key={v.id} className="py-2">v{v.version} · {v.name} · from {v.effectiveFrom} · {v.levels} levels, {v.rules} rules{v.enabled ? "" : " · matrix off"}</li>)}
              </ul>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
