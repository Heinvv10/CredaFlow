"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatDate } from "@/lib/utils"

export type RmcpVersion = {
  id: string
  version: number
  title: string
  fileName: string
  uploadedById: string
  uploadedAt: string
  approvedAt: string | null
  approvalNote: string | null
  reviewDueAt: string
  reviewState: "CURRENT" | "DUE_SOON" | "OVERDUE"
}

const REVIEW_BADGE = {
  CURRENT: { variant: "success" as const, label: "Review current" },
  DUE_SOON: { variant: "warning" as const, label: "Review due soon" },
  OVERDUE: { variant: "danger" as const, label: "Review overdue" },
}

export function RmcpPanel({ versions, viewerId }: { versions: RmcpVersion[]; viewerId: string | null }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function upload(form: HTMLFormElement) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/compliance/fic/rmcp", { method: "POST", body: new FormData(form) })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? "Upload failed.")
      form.reset()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.")
    } finally {
      setBusy(false)
    }
  }

  async function approve(id: string) {
    setError(null)
    const approvalNote = window.prompt("Approval note (who approved it and how, e.g. board resolution reference):") ?? ""
    const res = await fetch(`/api/compliance/fic/rmcp/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalNote }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) setError(body.error ?? "Not approved.")
    else router.refresh()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Risk Management and Compliance Programme (RMCP)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--cf-text-muted)]">
          Upload the lender&apos;s own RMCP as approved by its compliance function. CredaFlow stores and dates it; it does not write it.
        </p>
        {versions.length === 0 && <p className="text-sm text-[var(--cf-warning)]">No RMCP has been uploaded.</p>}
        {versions.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm">
            <span className="font-medium text-[var(--cf-text)]">v{v.version} · {v.title}</span>
            <Badge variant={REVIEW_BADGE[v.reviewState].variant}>{REVIEW_BADGE[v.reviewState].label} · {formatDate(v.reviewDueAt)}</Badge>
            {v.approvedAt ? (
              <Badge variant="success">Approved {formatDate(v.approvedAt)}</Badge>
            ) : v.uploadedById === viewerId ? (
              <span className="text-xs text-[var(--cf-text-muted)]">Awaiting approval by another compliance officer</span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => approve(v.id)}>Record approval</Button>
            )}
            <a className="text-[var(--cf-brand-soft)] hover:underline" href={`/api/compliance/fic/rmcp/${v.id}`}>Download</a>
          </div>
        ))}
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            void upload(e.currentTarget)
          }}
        >
          <div className="space-y-1"><Label htmlFor="rmcp-title">Title</Label><Input id="rmcp-title" name="title" required /></div>
          <div className="space-y-1"><Label htmlFor="rmcp-review">Review by</Label><Input id="rmcp-review" name="reviewDueAt" type="date" required /></div>
          <div className="space-y-1"><Label htmlFor="rmcp-file">PDF</Label><Input id="rmcp-file" name="file" type="file" accept="application/pdf" required /></div>
          <div className="sm:col-span-3"><Button type="submit" disabled={busy}>{busy ? "Uploading…" : "Upload new version"}</Button></div>
        </form>
        {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
      </CardContent>
    </Card>
  )
}
