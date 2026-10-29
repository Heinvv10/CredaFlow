"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import type { SimulationReport } from "@/lib/decisioning/simulate"
import { api } from "./types"

const KINDS = ["APPROVE", "REFER", "DECLINE"] as const

interface Props {
  /** What to replay: a draft being edited (draft) or an approved version (versionId). */
  source: { draft: { productId: string | null; rules: unknown; scorecard: unknown } } | { versionId: string }
  label?: string
}

/** Runs the candidate over recent real applications (read-only) and shows what would change against the version in force. */
export function SimulationPanel({ source, label = "Simulate on recent applications" }: Props) {
  const [report, setReport] = useState<SimulationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string[]>([])

  async function run() {
    setBusy(true)
    setProblem([])
    const res = await api<{ report: SimulationReport }>("/api/settings/decision-rules/simulate", "POST", source)
    setBusy(false)
    if (res.ok && res.data) setReport(res.data.report)
    else setProblem(res.problems.length > 0 ? res.problems : [res.error ?? "Simulation failed."])
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={run}>{busy ? "Simulating…" : label}</Button>
        <span className="text-xs text-[var(--cf-text-muted)]">Read-only: nothing is decided, written or sent.</span>
      </div>
      {problem.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-danger)]">{problem.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      {report && (
        <div className="space-y-4 rounded-lg border border-[var(--cf-border-subtle)] p-4 text-sm" aria-label="Simulation report">
          <p>
            {report.sampled} application{report.sampled === 1 ? "" : "s"} submitted {report.window.from} to {report.window.to}; {report.withBureau} with a current bureau check.
            Compared with {report.liveRuleSet ? `the live rule set (${report.liveRuleSet})` : "no live rule set"}.
          </p>
          <table className="w-full max-w-md text-left">
            <thead><tr className="text-xs uppercase text-[var(--cf-text-muted)]"><th className="py-1">Verdict</th><th>Live</th><th>This version</th></tr></thead>
            <tbody>
              {KINDS.map((k) => (
                <tr key={k} className="border-t border-[var(--cf-border-subtle)]"><td className="py-1">{k.toLowerCase()}</td><td>{report.live ? report.live[k] : "—"}</td><td>{report.candidate[k]}</td></tr>
              ))}
            </tbody>
          </table>
          <div>
            <h4 className="font-semibold">Changes from live</h4>
            {report.changes.length === 0
              ? <p className="text-[var(--cf-text-muted)]">None: every application gets the same verdict.</p>
              : <ul className="list-disc pl-5">{report.changes.map((c) => <li key={`${c.from}-${c.to}`}>{c.count} would move from {c.from.toLowerCase()} to {c.to.toLowerCase()}</li>)}</ul>}
          </div>
          <div>
            <h4 className="font-semibold">Rule hit rates</h4>
            {report.ruleHits.length === 0 ? <p className="text-[var(--cf-text-muted)]">No rules.</p> : (
              <table className="w-full max-w-lg text-left">
                <thead><tr className="text-xs uppercase text-[var(--cf-text-muted)]"><th className="py-1">Rule</th><th>Outcome</th><th>Hits</th><th>Rate</th></tr></thead>
                <tbody>{report.ruleHits.map((h) => <tr key={h.ruleId} className="border-t border-[var(--cf-border-subtle)]"><td className="py-1">{h.name}</td><td>{h.outcome.toLowerCase().replace("_", " ")}</td><td>{h.hits}</td><td>{h.hitRatePct}%</td></tr>)}</tbody>
              </table>
            )}
          </div>
          <div>
            <h4 className="font-semibold">Risk grades</h4>
            <p>{Object.entries(report.byGrade).map(([g, n]) => `${g === "UNGRADED" ? "ungraded" : `grade ${g}`}: ${n}`).join(" · ") || "—"}</p>
          </div>
          <div>
            <h4 className="font-semibold">Against what staff decided</h4>
            <p>
              Of {report.againstStaff.approvedByStaff} approved by staff, {report.againstStaff.candidateWouldDecline} would be declined.
              Of {report.againstStaff.declinedByStaff} declined by staff, {report.againstStaff.candidateWouldApprove} would be approved.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
