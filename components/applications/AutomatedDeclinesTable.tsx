"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface DeclineRowView {
  runId: string
  applicationId: string
  reference: string | null
  status: string
  decidedAt: string
  reasonCodes: string[]
  riskGrade: string | null
  ruleSet: string
}

/** Automated declines for staff to review, each with "Request human review": a person decides the application afresh. */
export function AutomatedDeclinesTable({ rows, canAct }: { rows: DeclineRowView[]; canAct: boolean }) {
  const router = useRouter()
  const [open, setOpen] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(applicationId: string) {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/applications/${applicationId}/auto-decision/human-review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
    }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { error?: string } | null
    setBusy(false)
    if (!res?.ok) return setError(body?.error ?? "Could not reopen the application.")
    setOpen(null)
    setReason("")
    router.refresh()
  }

  if (rows.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">The decision engine has not declined any application.</p>
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <table className="w-full text-left text-sm">
        <thead><tr className="text-xs uppercase text-[var(--cf-text-muted)]"><th className="py-2">Application</th><th>Decided</th><th>Reason codes</th><th>Grade</th><th>Rule set</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.runId} className="border-t border-[var(--cf-border-subtle)] align-top">
              <td className="py-2"><a className="underline" href={`/applications/${row.applicationId}`}>{row.reference ?? row.applicationId}</a></td>
              <td>{new Date(row.decidedAt).toLocaleString("en-ZA")}</td>
              <td>{row.reasonCodes.join(", ")}</td>
              <td>{row.riskGrade ?? "—"}</td>
              <td>{row.ruleSet}</td>
              <td><Badge variant={row.status === "DECLINED" ? "danger" : "info"}>{row.status.toLowerCase().replace("_", " ")}</Badge></td>
              <td>
                {canAct && row.status === "DECLINED" && (open === row.applicationId ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Input aria-label="Reason for human review" className="w-72" placeholder="Why a person should review it (10+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Button size="sm" disabled={busy} onClick={() => submit(row.applicationId)}>Reopen for review</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                  </span>
                ) : <Button size="sm" variant="outline" onClick={() => { setOpen(row.applicationId); setReason(""); setError(null) }}>Request human review</Button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
