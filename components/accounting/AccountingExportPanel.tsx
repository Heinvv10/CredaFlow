"use client"

import { useEffect, useRef, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatZAR } from "@/lib/utils"
import { ControlsList, RefusalNotice, type ControlRow } from "./AccountingChecks"
import { AccountingHistory, type Batch } from "./AccountingHistory"
import { IsaFlowPushControl } from "./IsaFlowPushControl"

interface Preview {
  period: string
  label: string
  closed: boolean
  batchId: string | null
  goLive?: boolean
  entryCount: number
  debitCents: number
  creditCents: number
  accounts: Array<{ role: string; accountCode: string; name: string; debitCents: number; creditCents: number }>
  events: Record<string, number>
  refusal: { code: string; message: string } | null
  controls?: ControlRow[]
  reconciliation: { journalTotalCents: number; bookTotalCents: number; mismatches: Array<{ loanId: string; reference: string; journalCents: number; bookCents: number }> } | null
}

type Snapshot = { preview: (Preview & { error?: string }) | null; previewError: string | null; batches: Batch[] | null }

async function fetchSnapshot(period: string): Promise<Snapshot> {
  const [p, h] = await Promise.all([
    fetch(`/api/accounting/preview?period=${encodeURIComponent(period)}`),
    fetch("/api/accounting/periods"),
  ])
  const pj = (await p.json().catch(() => ({}))) as Preview & { error?: string }
  const batches = h.ok ? ((await h.json()) as { batches: Batch[] }).batches : null
  return p.ok
    ? { preview: pj, previewError: null, batches }
    : { preview: null, previewError: pj.error ?? `Preview failed (${p.status})`, batches }
}

export function AccountingExportPanel({ initialPeriod, canClose, xeroConnected, isaflowConnected, revision = 0, settingsBusy = false, onClosed, onMutationStart, onMutationEnd }: { initialPeriod: string; canClose: boolean; xeroConnected: boolean; isaflowConnected: boolean; revision?: number; settingsBusy?: boolean; onClosed?: () => void; onMutationStart?: () => void; onMutationEnd?: () => void }) {
  const [period, setPeriod] = useState(initialPeriod)
  const [loaded, setLoaded] = useState<{ key: string; preview: Preview | null } | null>(null)
  const key = `${period}:${revision}:${settingsBusy}`
  const currentKey = useRef(key)
  currentKey.current = key
  const request = useRef(0)
  const preview = loaded?.key === key ? loaded.preview : null
  useEffect(() => { setPeriod(initialPeriod) }, [initialPeriod])
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  function applySnapshot(snap: Snapshot, forKey: string) {
    setLoaded({ key: forKey, preview: snap.preview })
    if (snap.previewError !== null) setMessage(snap.previewError)
    if (snap.batches) setBatches(snap.batches)
  }

  // A revision invalidates the rendered preview before a settings write begins.
  // Neither an earlier GET nor a POST refresh may restore that old snapshot.
  useEffect(() => {
    const id = ++request.current
    if (settingsBusy) return
    let ignore = false
    setMessage(null)
    void fetchSnapshot(period).then((snap) => {
      if (!ignore && id === request.current && currentKey.current === key) applySnapshot(snap, key)
    }).catch(() => { if (!ignore && id === request.current) setMessage("Could not load the preview. Try again.") })
    return () => { ignore = true }
  }, [period, revision, settingsBusy, key])

  async function post(url: string, body: unknown, done: (json: Record<string, unknown>) => string) {
    const forKey = key
    const id = ++request.current
    setBusy(true)
    onMutationStart?.()
    setMessage(null)
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (res.ok && url === "/api/accounting/periods") onClosed?.()
      const message = res.ok ? done(json) : String(json.error ?? `Failed (${res.status})`)
      const snap = await fetchSnapshot(period)
      if (id === request.current && currentKey.current === forKey) { setMessage(message); applySnapshot(snap, forKey) }
    } catch {
      if (id === request.current && currentKey.current === forKey) setMessage("Network error; refresh to see the current state.")
    } finally {
      setBusy(false)
      onMutationEnd?.()
    }
  }

  const balanced = preview ? preview.debitCents === preview.creditCents : false
  const rec = preview?.reconciliation ?? null
  const closedBatch = preview?.closed && preview.batchId ? batches.find((b) => b.id === preview.batchId) : undefined

  return (
    <div className="space-y-6">
      <DataPanel
        title="Period"
        description="A SAST calendar month. Months close in order from the go-live month, once ended; closing seals its journals for good."
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="period" className="text-xs text-[var(--cf-text-muted)]">Month</label>
            <Input id="period" type="month" value={period} disabled={busy || settingsBusy} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-40" />
          </div>
        }
      >
        {preview && (
          <div className="space-y-4">
            {preview.goLive && <InfoStrip variant="default">Go-live month: history before {preview.label} posts as one opening entry.</InfoStrip>}
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard label="Status" value={preview.closed ? "Closed" : "Open (preview)"} />
              <MetricCard label="Journal entries" value={String(preview.entryCount)} />
              <MetricCard label="Debits" value={formatZAR(preview.debitCents)} />
              <MetricCard label="Credits" value={formatZAR(preview.creditCents)} tone={balanced ? "neutral" : "warning"} detail={balanced ? "Balanced" : "Does not balance"} />
            </div>
            {rec && (
              <div className="rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm">
                <p className="text-[var(--cf-text)]">
                  Loan-book tie-out at month end: journal {formatZAR(rec.journalTotalCents)} · owed by borrowers {formatZAR(rec.bookTotalCents)} ·{" "}
                  <span className={rec.mismatches.length ? "font-semibold text-[var(--cf-danger)]" : "font-semibold text-[var(--cf-success)]"}>
                    {rec.mismatches.length ? `${rec.mismatches.length} loan(s) differ` : "ties"}
                  </span>
                </p>
                {rec.mismatches.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs text-[var(--cf-text-secondary)]">
                    {rec.mismatches.slice(0, 10).map((m) => (
                      <li key={m.loanId}>{m.reference}: journal {formatZAR(m.journalCents)}, owed {formatZAR(m.bookCents)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {preview.controls && <ControlsList controls={preview.controls} />}
            {preview.refusal && !preview.closed && <RefusalNotice refusal={preview.refusal} />}
            {preview.accounts.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead className="text-right">Debit</TableHead>
                    <TableHead className="text-right">Credit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.accounts.map((a) => (
                    <TableRow key={`${a.role}-${a.accountCode}`}>
                      <TableCell>{a.name}</TableCell>
                      <TableCell className="tabular-nums">{a.accountCode}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.debitCents ? formatZAR(a.debitCents) : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.creditCents ? formatZAR(a.creditCents) : ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-[var(--cf-text-muted)]">Nothing to post for {preview.label}.</p>
            )}
            <p className="text-xs text-[var(--cf-text-muted)]">
              Events: {Object.entries(preview.events).map(([k, v]) => `${k.replaceAll("_", " ").toLowerCase()} ${v}`).join(", ") || "none"}
            </p>
            <div className="flex flex-wrap gap-2">
              {!preview.closed && canClose && (
                <Button disabled={busy || settingsBusy || !balanced || preview.refusal !== null} onClick={() => post("/api/accounting/periods", { period: preview.period }, () => `${preview.label} closed.`)}>
                  Close {preview.label}
                </Button>
              )}
              {preview.closed && preview.batchId && (
                <>
                  <a className="btn-outline-gold inline-block text-center text-sm" href={`/api/accounting/batches/${preview.batchId}/csv?format=generic`} download>Download CSV</a>
                  <a className="btn-outline-gold inline-block text-center text-sm" href={`/api/accounting/batches/${preview.batchId}/csv?format=sage`} download>Download Sage CSV</a>
                </>
              )}
            </div>
            {closedBatch && <IsaFlowPushControl batch={closedBatch} canAdmin={canClose} connected={isaflowConnected} busy={busy || settingsBusy} post={post} />}
          </div>
        )}
        {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
      </DataPanel>

      <AccountingHistory batches={batches} canAdmin={canClose} xeroConnected={xeroConnected} isaflowConnected={isaflowConnected} busy={busy || settingsBusy} post={post} />
    </div>
  )
}
