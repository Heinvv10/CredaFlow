"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { GROUNDS_MIN_LENGTH, TIPPING_OFF_WARNING } from "@/lib/fic/str-copy"

/**
 * Raises an internal suspicious / unusual activity report about a client (and
 * optionally one of their loans). The raiser gets a reference back and never
 * sees the register. Nothing about the report is shown on the client's file.
 */
export function RaiseStrButton({ clientId, loanId }: { clientId: string; loanId?: string }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState("SUSPICIOUS_TRANSACTION")
  const [grounds, setGrounds] = useState("")
  const [reference, setReference] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/compliance/fic/str", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, grounds, clientId, loanId }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; reference?: string }
      if (!res.ok || !body.reference) throw new Error(body.error ?? "The report was not raised.")
      setReference(body.reference)
      setGrounds("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report was not raised.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(true); setReference(null) }}>
        Report suspicious activity
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report suspicious or unusual activity</DialogTitle>
          </DialogHeader>
          <p className="rounded-md border border-[var(--cf-danger)] p-3 text-sm text-[var(--cf-danger)]" role="alert">{TIPPING_OFF_WARNING}</p>
          {reference ? (
            <p className="text-sm text-[var(--cf-text)]">
              Raised as <span className="font-mono">{reference}</span>. The compliance officer will assess it. Keep the reference; do not record it on the client&apos;s file.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="str-kind">What kind</Label>
                <select
                  id="str-kind"
                  className="h-9 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] px-2 text-sm text-[var(--cf-text)]"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="SUSPICIOUS_TRANSACTION">Suspicious transaction</option>
                  <option value="UNUSUAL_TRANSACTION">Unusual transaction</option>
                  <option value="SUSPICIOUS_ACTIVITY">Suspicious activity (no transaction)</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="str-grounds">Grounds (at least {GROUNDS_MIN_LENGTH} characters)</Label>
                <Textarea id="str-grounds" value={grounds} onChange={(e) => setGrounds(e.target.value)} placeholder="What you saw, when, and why it is suspicious or unusual." />
              </div>
              {error && <p className="text-xs text-[var(--cf-danger)]">{error}</p>}
              <Button onClick={submit} disabled={busy || grounds.trim().length < GROUNDS_MIN_LENGTH}>
                {busy ? "Raising…" : "Raise report"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
