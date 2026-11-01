"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { LOAN_CHANGE_LABELS, type LoanChangeType } from "@/lib/loan-changes/types"
import type { LoanChangesView } from "@/lib/loan-changes/view"
import { formatDateTime } from "@/lib/utils"
import { ChangePreviewTable } from "./ChangePreviewTable"

const TONE = { DRAFT: "neutral", SUBMITTED: "warning", APPROVED: "success", REJECTED: "danger", WITHDRAWN: "neutral" } as const

/** One proposal. Approve, reject and withdraw are affordances: the service holds who may. */
export function ChangeRequestCard({ request }: { request: LoanChangesView["requests"][number] }) {
  const router = useRouter()
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = request.status === "DRAFT" || request.status === "SUBMITTED"

  async function act(action: "approve" | "reject" | "withdraw") {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/maker-checker/${request.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) })
    setBusy(false)
    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as { error?: string }
      setError(json.error ?? `Request failed (${response.status})`)
      return
    }
    setNote("")
    router.refresh()
  }

  return (
    <div className="space-y-2 rounded border border-[var(--cf-border-subtle)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-[var(--cf-text)]">{LOAN_CHANGE_LABELS[request.type as LoanChangeType]}</span>
        <StatusPill tone={TONE[request.status as keyof typeof TONE]}>{request.status}</StatusPill>
      </div>
      <p className="text-[var(--cf-text-muted)]">{request.reason}</p>
      <p className="text-xs text-[var(--cf-text-muted)]">
        Proposed by {request.maker}, {formatDateTime(request.createdAt)}
        {request.checker ? `. Decided by ${request.checker}${request.decidedAt ? `, ${formatDateTime(request.decidedAt)}` : ""}` : ""}
        {request.decisionNote ? `: ${request.decisionNote}` : ""}
      </p>
      {request.signedDocument
        ? <a className="block text-xs font-medium underline" href={`/api/documents/${request.signedDocument.id}/view`} target="_blank" rel="noreferrer">Signed document: {request.signedDocument.fileName}</a>
        : <p className="text-xs text-[var(--cf-danger)]">The signed document is no longer on file.</p>}
      {open && request.chain && (
        <p className="text-xs text-[var(--cf-text-muted)]">
          Approval matrix: {request.chain.required === null ? "no level recorded yet" : `${request.chain.recorded} of ${request.chain.required} levels recorded`}.{" "}
          <Link className="underline" href={`/applications/${request.chain.applicationId}`}>Its application</Link>
        </p>
      )}
      {open && request.preview && <ChangePreviewTable preview={request.preview} />}
      {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
      {request.canApprove && (
        <div className="space-y-2">
          <Textarea aria-label="Decision note" rows={2} placeholder="Note (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" disabled={busy} onClick={() => act("approve")}>Approve and apply</Button>
            <Button type="button" variant="outline" disabled={busy || note.trim() === ""} onClick={() => act("reject")}>Reject</Button>
          </div>
        </div>
      )}
      {open && request.mine && <Button type="button" variant="outline" disabled={busy} onClick={() => act("withdraw")}>Withdraw</Button>}
      {open && request.mine && request.status === "SUBMITTED" && <p className="text-xs text-[var(--cf-text-muted)]">Waiting for a second person: you cannot approve your own change.</p>}
    </div>
  )
}
