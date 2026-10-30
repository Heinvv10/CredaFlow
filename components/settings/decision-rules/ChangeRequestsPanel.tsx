"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { api, type ChangeRow } from "./types"

const STATUS_VARIANT = { DRAFT: "neutral", SUBMITTED: "warning", APPROVED: "success", REJECTED: "danger", WITHDRAWN: "neutral" } as const

function summary(row: ChangeRow): string {
  const p = row.payload as Record<string, unknown>
  if (row.kind === "DECISION_RULE_SET") {
    const rules = Array.isArray(p.rules) ? p.rules.length : 0
    return `${String(p.name)} · ${rules} rule${rules === 1 ? "" : "s"}${p.scorecard ? " + scorecard" : ""} · from ${String(p.effectiveFrom)}${p.challengerOnly ? " · challenger only" : ""}`
  }
  if (row.kind === "DECISION_ENGINE_CONFIG") {
    return `mode ${String(p.mode)} · ${(p.channels as string[]).join(", ") || "no channels"} · ${(p.productIds as string[]).length} product(s) · challenger ${String(p.challengerPercent)}%`
  }
  return row.title
}

interface Props {
  requests: ChangeRow[]
  onEdit: (row: ChangeRow) => void
  onDone: () => void
  /** Replaces the default line under the title (used by the product versions page). */
  description?: string
}

/** Pending and recent changes. The person who drafted a change sees "Withdraw"; anyone else with approval rights sees "Approve" and "Reject". */
export function ChangeRequestsPanel({ requests, onEdit, onDone, description }: Props) {
  const [note, setNote] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(row: ChangeRow, action: "submit" | "approve" | "reject" | "withdraw") {
    setBusy(row.id)
    setError(null)
    const res = await api(`/api/maker-checker/${row.id}/${action}`, "POST", { note: note[row.id] ?? "" })
    setBusy(null)
    if (!res.ok) {
      setError(res.problems.length > 0 ? res.problems.join(" ") : res.error)
      return
    }
    onDone()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
        <CardDescription>{description ?? "Every change to rules, scorecards and engine settings needs a second person. You cannot approve what you drafted."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
        {requests.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No changes yet.</p>}
        {requests.map((row) => (
          <div key={row.id} className="space-y-2 rounded-lg border border-[var(--cf-border-subtle)] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[row.status]}>{row.status.toLowerCase()}</Badge>
              <span className="font-medium">{row.title}</span>
              <span className="text-xs text-[var(--cf-text-muted)]">{row.label} · {new Date(row.createdAt).toLocaleDateString("en-ZA")}{row.mine ? " · yours" : ""}</span>
            </div>
            <p className="text-sm text-[var(--cf-text-secondary)]">{summary(row)}</p>
            {row.decisionNote && <p className="text-sm">Note: {row.decisionNote}</p>}
            <div className="flex flex-wrap items-center gap-2">
              {row.status === "DRAFT" && row.mine && <>
                <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "submit")}>Submit for approval</Button>
                {row.kind === "DECISION_RULE_SET" && <Button size="sm" variant="outline" onClick={() => onEdit(row)}>Edit</Button>}
                <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => act(row, "withdraw")}>Withdraw</Button>
              </>}
              {row.status === "SUBMITTED" && row.mine && <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => act(row, "withdraw")}>Withdraw</Button>}
              {row.status === "SUBMITTED" && row.canApprove && <>
                <Input aria-label="Note" placeholder="Note (required to reject)" className="w-64" value={note[row.id] ?? ""} onChange={(e) => setNote({ ...note, [row.id]: e.target.value })} />
                <Button size="sm" disabled={busy === row.id} onClick={() => act(row, "approve")}>Approve</Button>
                <Button size="sm" variant="destructive" disabled={busy === row.id} onClick={() => act(row, "reject")}>Reject</Button>
              </>}
              {row.status === "SUBMITTED" && !row.canApprove && !row.mine && <span className="text-xs text-[var(--cf-text-muted)]">Waiting for an approver.</span>}
              {row.status === "SUBMITTED" && row.mine && <span className="text-xs text-[var(--cf-text-muted)]">Waiting for a second person: you cannot approve your own change.</span>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
