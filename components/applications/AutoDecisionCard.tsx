"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface Run {
  id: string
  createdAt: string
  mode: "SHADOW" | "LIVE"
  role: "CHAMPION" | "CHALLENGER"
  verdict: "APPROVE" | "DECLINE" | "REFER"
  execution: "APPROVED" | "DECLINED" | "REFERRED" | "NOT_ACTED"
  reasonCodes: string[]
  riskGrade: string | null
  score: number | null
  latencyMs: number
  note: string | null
  ruleSet: string
  ruleSetName: string
}

interface Props {
  applicationId: string
  /** LOAN_ADMIN and above, while the application is under review. */
  canRun: boolean
}

const EXECUTION_TEXT: Record<Run["execution"], string> = {
  APPROVED: "Approved automatically",
  DECLINED: "Declined automatically",
  REFERRED: "Referred to staff",
  NOT_ACTED: "Shadow run, no action taken",
}

/** What the lender's decision engine concluded about this application and why; renders nothing for a lender that has never run it. */
export function AutoDecisionCard({ applicationId, canRun }: Props) {
  const router = useRouter()
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const [reload, setReload] = useState(0)

  useEffect(() => {
    let ignore = false
    fetch(`/api/applications/${applicationId}/auto-decision`)
      .then(async (res) => (res.ok ? ((await res.json()) as { runs: Run[] }).runs : null))
      .then((loaded) => { if (!ignore && loaded) setRuns(loaded) })
      .catch((error: unknown) => console.error("[auto-decision] could not load runs:", error))
    return () => { ignore = true }
  }, [applicationId, reload])

  async function runNow() {
    setBusy(true)
    setMessage(null)
    const res = await fetch(`/api/applications/${applicationId}/auto-decision`, { method: "POST" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { status?: string; reason?: string; execution?: Run["execution"]; error?: string } | null
    setBusy(false)
    setMessage(!res?.ok ? (body?.error ?? "The decision engine could not run.") : body?.status === "SKIPPED" ? `Not run: ${body.reason?.replaceAll("_", " ")}.` : EXECUTION_TEXT[body?.execution ?? "REFERRED"])
    setReload((n) => n + 1)
    router.refresh()
  }

  if (!runs || (runs.length === 0 && !canRun)) return null
  const latest = runs[0]
  return (
    <section aria-label="Decision engine" className="space-y-3 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Decision engine</h2>
        {latest?.riskGrade && <Badge variant="info">Risk grade {latest.riskGrade}{latest.score !== null ? ` (score ${latest.score})` : ""}</Badge>}
        {canRun && <Button size="sm" variant="outline" disabled={busy} onClick={runNow}>Run decision engine</Button>}
      </div>
      {message && <p role="status" className="text-sm">{message}</p>}
      {runs.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">The engine has not run on this application.</p>}
      <ul className="space-y-2">
        {runs.slice(0, 3).map((run) => (
          <li key={run.id} className="space-y-1 text-sm">
            <p>
              <strong>{EXECUTION_TEXT[run.execution]}</strong>: rules said {run.verdict.toLowerCase()} · {run.ruleSet} ({run.ruleSetName}){run.role === "CHALLENGER" ? " · challenger" : ""} · {run.latencyMs} ms
            </p>
            <p className="text-[var(--cf-text-secondary)]">Reason codes: {run.reasonCodes.join(", ")}</p>
            {run.note && <p className="text-[var(--cf-text-secondary)]">Why staff must decide: {run.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}
