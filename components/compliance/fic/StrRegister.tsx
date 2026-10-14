"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { formatDate } from "@/lib/utils"
import { ficExportHref } from "@/lib/fic/str-copy"

export type StrRow = {
  id: string
  reference: string
  kind: string
  status: string
  raisedAt: string
  clientId: string | null
  clientName: string | null
  loanReference: string | null
  grounds: string
  assessmentNote: string | null
  fiuReference: string | null
  reportedAt: string | null
  raisedById: string
}

const STATUS_VARIANT: Record<string, "warning" | "info" | "success" | "neutral"> = {
  OPEN: "warning", UNDER_REVIEW: "info", REPORTED: "success", CLOSED_NO_REPORT: "neutral",
}

function CaseActions({ row, onDone }: { row: StrRow; onDone: () => void }) {
  const [fiuReference, setFiuReference] = useState("")
  const [reportedAt, setReportedAt] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function patch(body: Record<string, string>) {
    setError(null)
    const res = await fetch(`/api/compliance/fic/str/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const out = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      setError(out.error ?? "Not updated.")
      return
    }
    onDone()
  }

  return (
    <div className="mt-3 space-y-2">
      {row.status === "OPEN" && (
        <Button size="sm" variant="outline" onClick={() => patch({ status: "UNDER_REVIEW" })}>Start review</Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="FIC reference" placeholder="goAML reference" className="h-9 w-44" value={fiuReference} onChange={(e) => setFiuReference(e.target.value)} />
        <Input aria-label="Filed on" type="date" className="h-9 w-40" value={reportedAt} onChange={(e) => setReportedAt(e.target.value)} />
        <Button size="sm" onClick={() => patch({ status: "REPORTED", fiuReference, reportedAt, assessmentNote: note })}>Mark reported</Button>
      </div>
      <Textarea aria-label="Assessment note" placeholder="Assessment (required to close without reporting)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button size="sm" variant="secondary" onClick={() => patch({ status: "CLOSED_NO_REPORT", assessmentNote: note })}>Close without reporting</Button>
      {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}

function CaseCard({ c, viewerId, onDone }: { c: StrRow; viewerId: string; onDone: () => void }) {
  return (
    <div className="rounded-md border border-[var(--cf-border-subtle)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-[var(--cf-text)]">{c.reference}</span>
        <Badge variant={STATUS_VARIANT[c.status] ?? "neutral"}>{c.status.replaceAll("_", " ")}</Badge>
        <Badge variant="outline">{c.kind.replaceAll("_", " ").toLowerCase()}</Badge>
        <span className="text-xs text-[var(--cf-text-muted)]">Raised {formatDate(c.raisedAt)}</span>
      </div>
      <p className="mt-2 text-sm text-[var(--cf-text-secondary)]">
        {c.clientId ? <Link className="text-[var(--cf-brand-soft)] hover:underline" href={`/clients/${c.clientId}`}>{c.clientName}</Link> : "—"}
        {c.loanReference ? ` · loan ${c.loanReference}` : ""}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--cf-text)]">{c.grounds}</p>
      {c.assessmentNote && <p className="mt-2 text-sm text-[var(--cf-text-muted)]">Assessment: {c.assessmentNote}</p>}
      {c.fiuReference && <p className="mt-1 text-sm text-[var(--cf-success)]">Reported {c.reportedAt ? formatDate(c.reportedAt) : ""} · {c.fiuReference}</p>}
      {(c.status === "OPEN" || c.status === "UNDER_REVIEW") && (c.raisedById === viewerId
        ? <p className="mt-3 text-sm text-[var(--cf-text-muted)]">You raised this case; another compliance officer decides it.</p>
        : <CaseActions row={c} onDone={onDone} />)}
    </div>
  )
}

export function StrRegister({ open, decided, decidedTotal, viewerId }: { open: StrRow[]; decided: StrRow[]; decidedTotal: number; viewerId: string }) {
  const router = useRouter()
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Suspicious &amp; unusual transaction register ({open.length} open, {decidedTotal} decided)</CardTitle>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("str", "csv")} download>CSV (goAML-ready draft)</a></Button>
          <Button asChild size="sm" variant="outline"><a href={ficExportHref("str", "xml")} download>XML (goAML-ready draft)</a></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {open.length === 0 && decided.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No cases have been raised.</p>}
        {open.map((c) => <CaseCard key={c.id} c={c} viewerId={viewerId} onDone={() => router.refresh()} />)}
        {decided.length > 0 && (
          <p className="text-sm font-medium text-[var(--cf-text)]">
            Decided{decidedTotal > decided.length ? ` (newest ${decided.length} of ${decidedTotal} shown — the export has all)` : ""}
          </p>
        )}
        {decided.map((c) => <CaseCard key={c.id} c={c} viewerId={viewerId} onDone={() => router.refresh()} />)}
      </CardContent>
    </Card>
  )
}
