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

export function CtrRegister({ rows }: { rows: CtrRow[] }) {
  const router = useRouter()
  const unfiled = rows.filter((r) => r.filingStatus === "UNFILED").length
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Cash threshold register ({unfiled} unfiled)</CardTitle>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("ctr", "csv")} download>CSV (goAML-ready draft)</a></Button>
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("ctr", "xml")} download>XML (goAML-ready draft)</a></Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-[var(--cf-text-muted)]">
          Cash receipts at or above the configured threshold. The threshold figure must be confirmed by your compliance
          officer against the current FIC regulations before relying on this register.
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">No cash receipts at or above the threshold.</p>
        ) : (
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
                  <TableCell>
                    {r.filingStatus === "UNFILED" ? (
                      <RecordOutcome row={r} onDone={() => router.refresh()} />
                    ) : (
                      <Badge variant={r.filingStatus === "FILED" ? "success" : "neutral"}>
                        {r.filingStatus === "FILED" ? `Filed · ${r.fiuReference}` : "Not reportable"}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
