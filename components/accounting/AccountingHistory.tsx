"use client"

import { useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatZAR } from "@/lib/utils"

export interface Batch {
  id: string
  periodKey: string
  entryCount: number
  lineCount: number
  totalDebitCents: number
  totalCreditCents: number
  closedAt: string
  xeroPush: { status: string; xeroManualJournalId: string | null; error: string | null } | null
}

type Post = (url: string, body: unknown, done: (json: Record<string, unknown>) => string) => Promise<void>

const PUSH_TONE: Record<string, "success" | "warning" | "danger" | "info"> = { PUSHED: "success", SENDING: "info", FAILED: "danger", NEEDS_REVIEW: "danger" }

/** Resolving a push whose outcome is unknown, after checking Xero. */
function ResolvePush({ batch, busy, post }: { batch: Batch; busy: boolean; post: Post }) {
  const [journalId, setJournalId] = useState("")
  const [note, setNote] = useState("")
  const url = `/api/accounting/batches/${batch.id}/xero`
  return (
    <div className="mt-2 space-y-2 text-left">
      <p className="text-xs text-[var(--cf-text-muted)]">Look for this month&apos;s draft manual journal in Xero, then say what you found.</p>
      <Input placeholder="Xero manual journal id (if it is there)" value={journalId} onChange={(e) => setJournalId(e.target.value)} />
      <Input placeholder="What you checked (required)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || note.trim().length < 5 || !journalId.trim()} onClick={() => post(url, { action: "resolve", outcome: "pushed", manualJournalId: journalId, note }, () => "Recorded as pushed.")}>It is in Xero</Button>
        <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => post(url, { action: "resolve", outcome: "not_pushed", note }, () => "Recorded as not pushed; it can be pushed again.")}>It is not in Xero</Button>
      </div>
    </div>
  )
}

export function AccountingHistory({ batches, canAdmin, xeroConnected, busy, post }: { batches: Batch[]; canAdmin: boolean; xeroConnected: boolean; busy: boolean; post: Post }) {
  return (
    <DataPanel title="Export history" description={xeroConnected ? "Closed months. Push sends one DRAFT manual journal per month to Xero." : "Closed months. Connect Xero under Settings → Integrations to push journals."}>
      {batches.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">No month has been closed yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Debits = Credits</TableHead>
              <TableHead>Closed</TableHead>
              <TableHead>Xero</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((b) => {
              const push = b.xeroPush
              const url = `/api/accounting/batches/${b.id}/xero`
              return (
                <TableRow key={b.id}>
                  <TableCell>{b.periodKey}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.entryCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatZAR(b.totalDebitCents)}</TableCell>
                  <TableCell>{new Date(b.closedAt).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })}</TableCell>
                  <TableCell>
                    {push ? <StatusPill tone={PUSH_TONE[push.status] ?? "info"}>{push.status.replace("_", " ")}</StatusPill> : <span className="text-xs text-[var(--cf-text-muted)]">Not pushed</span>}
                    {push?.error && <p className="mt-1 max-w-xs text-[11px] text-[var(--cf-text-muted)]">{push.error}</p>}
                  </TableCell>
                  <TableCell className="space-x-2 text-right align-top">
                    <a className="text-xs text-[var(--cf-brand)] hover:underline" href={`/api/accounting/batches/${b.id}/csv?format=generic`} download>CSV</a>
                    <a className="text-xs text-[var(--cf-brand)] hover:underline" href={`/api/accounting/batches/${b.id}/csv?format=sage`} download>Sage</a>
                    {canAdmin && xeroConnected && (!push || push.status === "FAILED") && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => post(url, { action: "push" }, (j) => `Pushed to Xero (journal ${String(j.manualJournalId)}).`)}>Push to Xero</Button>
                    )}
                    {canAdmin && push?.status === "SENDING" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => post(url, { action: "check" }, (j) => (j.movedToReview ? "No answer was recorded: moved to review." : "Still within its 10 minutes; check again later."))}>Check</Button>
                    )}
                    {canAdmin && push?.status === "NEEDS_REVIEW" && <ResolvePush batch={b} busy={busy} post={post} />}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </DataPanel>
  )
}
