"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { controlClass } from "@/components/settings/decision-rules/types"
import type { ApprovalProgress } from "@/lib/approval/progress"

const STATE_BADGE = { APPROVED: "success", PENDING: "warning", WAITING: "neutral", NOT_REQUIRED: "neutral" } as const
const STATE_LABEL = { APPROVED: "Approved", PENDING: "Awaiting", WAITING: "Waiting", NOT_REQUIRED: "Not needed" } as const
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean)
const day = (iso: string) => iso.slice(0, 10)

interface Props {
  applicationId: string
  progress: ApprovalProgress
  /** The viewer may open the committee pack and record decisions (view_committee_pack, record_committee_decision). */
  canUseCommittee: boolean
  today: string
}

/** Where the application is in its approval chain: each level, who approved it, the turnaround clock, escalations, and the credit committee's decisions. */
export function ApprovalProgressPanel({ applicationId, progress, canUseCommittee, today }: Props) {
  const router = useRouter()
  const [decision, setDecision] = useState<"APPROVED" | "DECLINED" | "DEFERRED">("APPROVED")
  const [meetingDate, setMeetingDate] = useState(today)
  const [attendees, setAttendees] = useState("")
  const [conditions, setConditions] = useState("")
  const [rationale, setRationale] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!progress.applies) return null

  const committee = progress.levels.find((l) => l.committee)
  const atCommittee = progress.status === "OPEN" && committee !== undefined && committee.state === "PENDING"
  const canRecord = canUseCommittee && atCommittee && progress.viewer.authorityLevel >= (committee?.level ?? 99)

  async function record() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/applications/${applicationId}/committee`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, meetingDate, attendees: lines(attendees), conditions: decision === "APPROVED" ? lines(conditions) : [], rationale }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] }
    setBusy(false)
    if (!res.ok) return setError(body.problems?.[0] ?? body.error ?? "Could not record the decision.")
    setRationale("")
    router.refresh()
  }

  return (
    <section className="w-full space-y-3 rounded-lg border border-[var(--cf-border-subtle)] p-3 text-sm" aria-label="Approval chain">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Approval chain</h3>
        <span className="text-xs text-[var(--cf-text-muted)]">{progress.matrixName} v{progress.matrixVersion}</span>
      </div>
      <p className="text-xs text-[var(--cf-text-secondary)]">
        {progress.requiredLevels === 0 ? "No staff approval chain is required for this application." : `${progress.requiredLevels} level${progress.requiredLevels === 1 ? "" : "s"} must approve, in order, each by a different person.`}
        {progress.matchedRules.length > 0 && ` Because of: ${progress.matchedRules.map((r) => r.name).join(", ")}.`}
        {!progress.requirementFrozen && " (Set when the first approval is attempted.)"}
      </p>
      <ol className="space-y-2">
        {progress.levels.map((l) => (
          <li key={l.level} className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_BADGE[l.state]}>{STATE_LABEL[l.state]}</Badge>
            <span className="font-medium">Level {l.level}: {l.name}</span>
            <span className="text-xs text-[var(--cf-text-muted)]">{l.role}{l.committee ? " · committee" : ""}</span>
            {l.approvedBy && <span className="text-xs">by {l.approvedBy}{l.via === "DELEGATION" ? " (delegated authority)" : ""} on {day(l.approvedAt ?? "")}</span>}
            {l.conditions.length > 0 && <ul className="w-full list-disc pl-8 text-xs">{l.conditions.map((c) => <li key={c}>{c}</li>)}</ul>}
          </li>
        ))}
      </ol>
      {progress.status === "OPEN" && progress.dueAt && (
        <p className={progress.overdue ? "text-xs font-semibold text-[var(--cf-danger)]" : "text-xs text-[var(--cf-text-muted)]"}>
          Level {progress.pendingLevel} is due {new Date(progress.dueAt).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}{progress.overdue ? ` · overdue, escalated ${progress.escalationCount} time${progress.escalationCount === 1 ? "" : "s"}` : ""}
        </p>
      )}
      {progress.escalations.length > 0 && <ul className="list-disc pl-5 text-xs">{progress.escalations.map((e) => <li key={e.at}>Escalated from level {e.fromLevel} to {e.toLevel} on {day(e.at)}; {e.notified} told</li>)}</ul>}
      {progress.status === "OPEN" && progress.viewer.reason && <p className="text-xs text-[var(--cf-text-secondary)]">You cannot approve the next level: {progress.viewer.reason}</p>}
      {progress.committeeDecisions.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold uppercase text-[var(--cf-text-muted)]">Credit committee</h4>
          <ul className="space-y-1 text-xs">
            {progress.committeeDecisions.map((d) => <li key={d.id}><strong>{d.decision}</strong> on {d.meetingDate} by {d.recordedBy}: {d.rationale}{d.conditions.length > 0 ? ` (${d.conditions.length} condition${d.conditions.length === 1 ? "" : "s"})` : ""}</li>)}
          </ul>
        </div>
      )}
      {canUseCommittee && <Link href={`/applications/${applicationId}/committee-pack`} className="inline-block text-xs underline">Credit committee pack</Link>}
      {canRecord && (
        <div className="space-y-2 border-t border-[var(--cf-border-subtle)] pt-3">
          <h4 className="text-xs font-semibold uppercase text-[var(--cf-text-muted)]">Record the committee&apos;s decision</h4>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label htmlFor="cc-decision">Decision</Label>
              <select id="cc-decision" className={controlClass} value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}><option value="APPROVED">Approved</option><option value="DEFERRED">Deferred</option><option value="DECLINED">Declined</option></select>
            </div>
            <div className="space-y-1"><Label htmlFor="cc-date">Meeting date</Label><Input id="cc-date" type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></div>
          </div>
          <div className="space-y-1"><Label htmlFor="cc-att">Members present (one per line)</Label><Textarea id="cc-att" rows={3} value={attendees} onChange={(e) => setAttendees(e.target.value)} /></div>
          {decision === "APPROVED" && <div className="space-y-1"><Label htmlFor="cc-cond">Conditions of approval (one per line)</Label><Textarea id="cc-cond" rows={3} value={conditions} onChange={(e) => setConditions(e.target.value)} /></div>}
          <div className="space-y-1"><Label htmlFor="cc-why">Rationale</Label><Textarea id="cc-why" rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} /></div>
          {error && <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p>}
          <Button size="sm" disabled={busy} onClick={record}>Record decision</Button>
        </div>
      )}
    </section>
  )
}
