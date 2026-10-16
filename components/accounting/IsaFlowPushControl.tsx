"use client"

import { useState } from "react"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DELETED_DRAFT_REPLAYED } from "@/lib/accounting/isaflow/messages"
import type { Batch } from "./AccountingHistory"

type Post = (url: string, body: unknown, done: (json: Record<string, unknown>) => string) => Promise<void>

const TONE: Record<string, "success" | "info" | "danger"> = { PUSHED: "success", SENDING: "info", FAILED: "danger", NEEDS_REVIEW: "danger" }

/** A closed month's IsaFlow draft journal: push it, check a push with no answer, or record what a person found. */
export function IsaFlowPushControl({ batch, canAdmin, connected, busy, post }: { batch: Batch; canAdmin: boolean; connected: boolean; busy: boolean; post: Post }) {
  const [journalId, setJournalId] = useState("")
  const [note, setNote] = useState("")
  const push = batch.isaflowPush ?? null
  const url = `/api/accounting/batches/${batch.id}/isaflow`
  // IsaFlow answers this batch's key with a draft deleted since: pushing again only replays it.
  const replayed = push?.error?.startsWith(DELETED_DRAFT_REPLAYED) ?? false
  const pushed = (j: Record<string, unknown>) => (j.foundOnReadBack ? `Found in IsaFlow as draft ${String(j.journalId)}; nothing was sent again.` : `In IsaFlow as draft journal ${String(j.journalId)}.`)

  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm" data-testid="isaflow-push">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--cf-text)]">IsaFlow</span>
        {push
          ? <StatusPill tone={TONE[push.status] ?? "info"}>{push.status.replace("_", " ")}</StatusPill>
          : <span className="text-xs text-[var(--cf-text-muted)]">Not pushed</span>}
        {push?.isaflowJournalId && (
          <span className="break-all text-xs text-[var(--cf-text-secondary)]">
            Draft {push.isaflowJournalId}{push.foundOnReadBack ? " (found on read-back)" : ""}
          </span>
        )}
      </div>
      {push?.error && <p className="text-xs text-[var(--cf-text-muted)]">{push.error}</p>}
      {replayed && (
        <p className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-2 text-xs text-[var(--cf-text)]">
          This month&apos;s draft was deleted in IsaFlow, and IsaFlow answers its key with that deleted draft, so pushing again will not
          create it. Post this month in IsaFlow from the{" "}
          <a className="text-[var(--cf-brand)] underline" href={`/api/accounting/batches/${batch.id}/csv?format=generic`} download>CSV download</a>
          {push?.status === "NEEDS_REVIEW" ? ", then resolve it here." : "."}
        </p>
      )}
      {!connected && !push && <p className="text-xs text-[var(--cf-text-muted)]">Connect IsaFlow under Settings → Integrations to push this month as a draft journal.</p>}
      {canAdmin && (
        <div className="flex flex-wrap gap-2">
          {connected && (!push || (push.status === "FAILED" && !replayed)) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => post(url, { action: "push" }, pushed)}>
              {push ? "Push to IsaFlow again" : "Push to IsaFlow"}
            </Button>
          )}
          {(push?.status === "SENDING" || push?.status === "NEEDS_REVIEW") && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => post(url, { action: "check" }, pushed)}>Check IsaFlow</Button>
          )}
        </div>
      )}
      {canAdmin && push?.status === "NEEDS_REVIEW" && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--cf-text-muted)]">If Check cannot settle it, look for this month&apos;s draft journal in IsaFlow, then say what you found.</p>
          <Input placeholder="IsaFlow journal id (if it is there)" value={journalId} onChange={(e) => setJournalId(e.target.value)} />
          <Input placeholder="What you checked (required)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || note.trim().length < 5 || !journalId.trim()} onClick={() => post(url, { action: "resolve", outcome: "pushed", journalId, note }, () => "Recorded as in IsaFlow.")}>It is in IsaFlow</Button>
            <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => post(url, { action: "resolve", outcome: "not_pushed", note }, () => (replayed ? "Recorded as not in IsaFlow. Post this month from the CSV download." : "Recorded as not in IsaFlow; it can be pushed again."))}>It is not in IsaFlow</Button>
          </div>
        </div>
      )}
    </div>
  )
}
