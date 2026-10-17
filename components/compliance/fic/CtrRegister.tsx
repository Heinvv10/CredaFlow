"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatZAR } from "@/lib/utils"
import { ficExportHref } from "@/lib/fic/str-copy"

export type CtrRow = {
  paymentId: string
  receivedAt: string
  amountCents: number
  loanReference: string
  clientName: string
  filingStatus: "UNFILED" | "FILED" | "NOT_REPORTABLE"
  fiuReference: string | null
  note: string | null
  receiptReversed: boolean
}

function RecordOutcome({ row, onDone }: { row: CtrRow; onDone: () => void }) {
  const [status, setStatus] = useState<"FILED" | "NOT_REPORTABLE">("FILED")
  const [fiuReference, setFiuReference] = useState("")
  const [filedAt, setFiledAt] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    const res = await fetch("/api/compliance/fic/ctr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: row.paymentId, status, fiuReference, filedAt, note }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      setError(body.error ?? "Not recorded.")
      return
    }
    onDone()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Outcome"
        className="h-9 rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] px-2 text-sm text-[var(--cf-text)]"
        value={status}
        onChange={(e) => setStatus(e.target.value as "FILED" | "NOT_REPORTABLE")}
      >
        <option value="FILED">Filed with the FIC</option>
        <option value="NOT_REPORTABLE">Not reportable</option>
      </select>
      {status === "FILED" ? (
        <>
          <Input aria-label="FIC reference" placeholder="goAML reference" className="h-9 w-40" value={fiuReference} onChange={(e) => setFiuReference(e.target.value)} />
          <Input aria-label="Filed on" type="date" className="h-9 w-40" value={filedAt} onChange={(e) => setFiledAt(e.target.value)} />
        </>
      ) : (
        <Input aria-label="Reason" placeholder="Why it is not reportable" className="h-9 w-72" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      <Button size="sm" onClick={submit}>Record</Button>
      {error && <span className="text-xs text-[var(--cf-danger)]">{error}</span>}
    </div>
  )
}

type Aggregate = { clientId: string; clientName: string; day: string; totalCents: number; paymentIds: string[] }

function Rows({ rows, onDone }: { rows: CtrRow[]; onDone: () => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Received</TableHead><TableHead>Amount</TableHead><TableHead>Client</TableHead>
          <TableHead>Loan</TableHead><TableHead>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.paymentId}>
            <TableCell>{formatDate(r.receivedAt)}</TableCell>
            <TableCell>{formatZAR(r.amountCents)}</TableCell>
            <TableCell>{r.clientName}</TableCell>
            <TableCell>{r.loanReference}</TableCell>
            <TableCell className="space-x-2">
              {r.filingStatus === "UNFILED" ? (
                <RecordOutcome row={r} onDone={onDone} />
              ) : (
                <Badge variant={r.filingStatus === "FILED" ? "success" : "neutral"}>
                  {r.filingStatus === "FILED" ? `Filed · ${r.fiuReference}` : "Not reportable"}
                </Badge>
              )}
              {r.receiptReversed && <Badge variant="warning">Receipt reversed after recording</Badge>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function CtrRegister({ unfiled, recorded, recordedTotal, pageSize, aggregates }: {
  unfiled: CtrRow[]
  recorded: CtrRow[]
  recordedTotal: number
  pageSize: number
  aggregates: Aggregate[]
}) {
  const router = useRouter()
  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-4 xl:flex-row xl:justify-between">
        <CardTitle>Cash threshold register ({unfiled.length} unfiled)</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("ctr", "csv")} download>CSV (goAML-ready draft)</a></Button>
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("ctr", "xml")} download>XML (goAML-ready draft)</a></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--cf-text-muted)]">
          Cash receipts at or above the configured threshold. The threshold figure must be confirmed by your compliance
          officer against the current FIC regulations before relying on this register. Exports contain every row.
        </p>
        {unfiled.length === 0
          ? <p className="text-sm text-[var(--cf-text-muted)]">No unfiled cash receipts at or above the threshold.</p>
          : <Rows rows={unfiled} onDone={() => router.refresh()} />}
        {aggregates.length > 0 && (
          <div className="rounded-md border border-[var(--cf-warning)] p-3 text-sm">
            <p className="font-medium text-[var(--cf-warning)]">Possible split deposits ({aggregates.length})</p>
            <p className="text-xs text-[var(--cf-text-muted)]">One client, one day, several cash receipts each under the threshold that together reach it. Review; whether they must be reported is your compliance officer&apos;s call.</p>
            <ul className="mt-2 space-y-1 text-[var(--cf-text-secondary)]">
              {aggregates.map((g) => (
                <li key={`${g.clientId}-${g.day}`}>{g.day} · {g.clientName} · {g.paymentIds.length} receipts · {formatZAR(g.totalCents)}</li>
              ))}
            </ul>
          </div>
        )}
        {recorded.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium text-[var(--cf-text)]">
              Recorded ({recordedTotal}{recordedTotal > recorded.length ? `, newest ${pageSize} shown — the export has all` : ""})
            </p>
            <Rows rows={recorded} onDone={() => router.refresh()} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
