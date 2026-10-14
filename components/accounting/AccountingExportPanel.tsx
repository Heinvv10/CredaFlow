"use client"

import { useCallback, useEffect, useState } from "react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatZAR } from "@/lib/utils"

interface Preview {
  period: string
  label: string
  closed: boolean
  batchId: string | null
  entryCount: number
  debitCents: number
  creditCents: number
  accounts: Array<{ role: string; accountCode: string; name: string; debitCents: number; creditCents: number }>
  events: Record<string, number>
}

interface Batch {
  id: string
  periodKey: string
  entryCount: number
  lineCount: number
  totalDebitCents: number
  totalCreditCents: number
  closedAt: string
  xeroPush: { status: string; xeroManualJournalId: string | null; error: string | null } | null
}

const PUSH_TONE: Record<string, "success" | "warning" | "danger" | "info"> = { PUSHED: "success", SENDING: "info", FAILED: "danger", NEEDS_REVIEW: "danger" }

export function AccountingExportPanel({ initialPeriod, canClose, xeroConnected }: { initialPeriod: string; canClose: boolean; xeroConnected: boolean }) {
  const [period, setPeriod] = useState(initialPeriod)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setMessage(null)
    const [p, h] = await Promise.all([
      fetch(`/api/accounting/preview?period=${encodeURIComponent(period)}`),
      fetch("/api/accounting/periods"),
    ])
    const pj = (await p.json().catch(() => ({}))) as Preview & { error?: string }
    if (p.ok) setPreview(pj)
    else { setPreview(null); setMessage(pj.error ?? `Preview failed (${p.status})`) }
    if (h.ok) setBatches(((await h.json()) as { batches: Batch[] }).batches)
  }, [period])

  useEffect(() => { void load() }, [load])

  async function post(url: string, body: unknown, done: (json: Record<string, unknown>) => string) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      setMessage(res.ok ? done(json) : String(json.error ?? `Failed (${res.status})`))
      await load()
    } catch {
      setMessage("Network error; refresh to see the current state.")
    } finally {
      setBusy(false)
    }
  }

  const balanced = preview ? preview.debitCents === preview.creditCents : false

  return (
    <div className="space-y-6">
      <DataPanel
        title="Period"
        description="A SAST calendar month. A month closes once it has ended, in order; closing seals its journals for good."
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="period" className="text-xs text-[var(--cf-text-muted)]">Month</label>
            <Input id="period" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-40" />
          </div>
        }
      >
        {preview && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <MetricCard label="Status" value={preview.closed ? "Closed" : "Open (preview)"} />
              <MetricCard label="Journal entries" value={String(preview.entryCount)} />
              <MetricCard label="Debits" value={formatZAR(preview.debitCents)} />
              <MetricCard label="Credits" value={formatZAR(preview.creditCents)} tone={balanced ? "neutral" : "warning"} detail={balanced ? "Balanced" : "Does not balance"} />
            </div>
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
                <Button disabled={busy || !balanced} onClick={() => post("/api/accounting/periods", { period: preview.period }, () => `${preview.label} closed.`)}>
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
          </div>
        )}
        {message && <p className="mt-3 text-sm text-[var(--cf-text-secondary)]" role="status">{message}</p>}
      </DataPanel>

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
              {batches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{b.periodKey}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.entryCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatZAR(b.totalDebitCents)}</TableCell>
                  <TableCell>{new Date(b.closedAt).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })}</TableCell>
                  <TableCell>
                    {b.xeroPush ? <StatusPill tone={PUSH_TONE[b.xeroPush.status] ?? "info"}>{b.xeroPush.status.replace("_", " ")}</StatusPill> : <span className="text-xs text-[var(--cf-text-muted)]">Not pushed</span>}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    <a className="text-xs text-[var(--cf-brand)] hover:underline" href={`/api/accounting/batches/${b.id}/csv?format=generic`} download>CSV</a>
                    <a className="text-xs text-[var(--cf-brand)] hover:underline" href={`/api/accounting/batches/${b.id}/csv?format=sage`} download>Sage</a>
                    {canClose && xeroConnected && (!b.xeroPush || b.xeroPush.status === "FAILED") && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => post(`/api/accounting/batches/${b.id}/xero`, { action: "push" }, (j) => `Pushed to Xero (journal ${String(j.manualJournalId)}).`)}>
                        Push to Xero
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>
    </div>
  )
}
