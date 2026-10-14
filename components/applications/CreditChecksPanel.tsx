"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { CLEAR_REASON_MAX_LENGTH, CLEAR_REASON_MIN_LENGTH } from "@/lib/credit-checks/policy"
import type { FlagView as ServerFlagView } from "@/lib/credit-checks/evidence"

type FlagView = Omit<ServerFlagView, "status"> & { status: "OPEN" | "CLEARED" | "SUPERSEDED" }
type CheckKind = FlagView["check"]

interface Props {
  applicationId: string
  canClear: boolean
  initialOpenCount: number
  /** A LOAN_ADMIN whose session did not verify two-factor authentication: say why Clear is missing. */
  needsTotp?: boolean
}

const GROUPS: Array<{ check: CheckKind; heading: string }> = [
  { check: "DOCUMENT_AUTHENTICITY", heading: "Document authenticity" },
  { check: "SALARY_MATCH", heading: "Salary match" },
  { check: "UNDISCLOSED_DEBT", heading: "Undisclosed debt" },
  { check: "RISK_BEHAVIOUR", heading: "Risk behaviour" },
  { check: "MANUAL_REVIEW", heading: "Manual review" },
  { check: "EXPENSE_UNDERSTATED", heading: "Declared expenses" },
]

function formatCents(cents: number): string {
  const abs = Math.abs(cents)
  const rands = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  const sign = cents < 0 ? "-" : ""
  return `${sign}R ${rands}.${(abs % 100).toString().padStart(2, "0")}`
}

function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error
    if (typeof e === "string" && e) return e
  }
  return fallback
}

function ClearForm({ applicationId, flagId, onDone }: {
  applicationId: string
  flagId: string
  onDone: () => void
}) {
  const [reason, setReason] = useState("")
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const length = [...reason.trim()].length

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/checks/${flagId}/clear`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (res.ok) {
        onDone()
        return
      }
      setError(errorText(await res.json().catch(() => null), "Could not clear this check."))
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Clear</Button>
  }
  return (
    <div className="mt-2 space-y-2">
      <Textarea
        autoFocus
        rows={2}
        maxLength={CLEAR_REASON_MAX_LENGTH}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this check being cleared? (min 15 characters)"
      />
      <p className="text-xs text-[var(--cf-text-muted)]">{length} / {CLEAR_REASON_MIN_LENGTH} characters minimum</p>
      {error && (
        <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={length < CLEAR_REASON_MIN_LENGTH || busy}>Confirm clear</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}

function Evidence({ flag }: { flag: FlagView }) {
  return (
    <>
      {flag.documentId && (
        <p className="mt-2 text-sm text-[var(--cf-text-secondary)]">
          <a
            href={`/api/documents/${flag.documentId}/view`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--cf-brand)] underline"
          >
            View statement
          </a>
          {flag.documentName ? ` ${flag.documentName}` : ""}
          {flag.pages.length > 0 ? ` (p. ${flag.pages.join(", ")})` : ""}
        </p>
      )}
      {flag.rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--cf-text-muted)]">
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 pr-3 font-medium">Description</th>
                <th className="py-1 pr-3 text-right font-medium">Amount</th>
                <th className="py-1 pr-3 text-right font-medium">Balance</th>
                <th className="py-1 font-medium">Page</th>
              </tr>
            </thead>
            <tbody>
              {flag.rows.map((r) => (
                <tr key={r.index} className="border-t border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]">
                  <td className="py-1 pr-3 whitespace-nowrap">{r.date}</td>
                  <td className="py-1 pr-3">{r.description}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(r.amountCents)}</td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">
                    {r.balanceCents === null ? "" : formatCents(r.balanceCents)}
                  </td>
                  <td className="py-1">{r.page}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

const sastDate = (iso: string) => new Date(iso).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })

export function CreditChecksPanel({ applicationId, canClear, initialOpenCount, needsTotp = false }: Props) {
  const router = useRouter()
  const [flags, setFlags] = useState<FlagView[] | null>(null)
  const [openCount, setOpenCount] = useState(initialOpenCount)
  const [error, setError] = useState<string | null>(null)
  const refreshedOnce = useRef(false)
  // Read through a ref so the server refresh below does not refire the fetch:
  // each fetch recomputes and logs a document access.
  const initialOpen = useRef(initialOpenCount)

  const load = useCallback(async () => {
    let next: { openCount: number; flags: FlagView[] } | string
    try {
      const res = await fetch(`/api/applications/${applicationId}/checks`, { cache: "no-store" })
      const body: unknown = await res.json().catch(() => null)
      next = res.ok
        ? (body as { openCount: number; flags: FlagView[] })
        : errorText(body, "Could not load credit checks.")
    } catch {
      next = "Network error. Could not load credit checks."
    }
    if (typeof next === "string") {
      setError(next)
      return
    }
    setError(null)
    setFlags(next.flags)
    setOpenCount(next.openCount)
    if (!refreshedOnce.current && next.openCount !== initialOpen.current) {
      refreshedOnce.current = true
      router.refresh()
    }
  }, [applicationId, router])

  useEffect(() => {
    // Fetch-on-mount: the state is set after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function onCleared() {
    await load()
    router.refresh()
  }

  return (
    <section
      data-testid="credit-checks-panel"
      className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--cf-text)]">Credit checks</h2>
        <span className="text-xs text-[var(--cf-text-muted)]">{openCount} open</span>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--cf-danger)]">{error}</p>}
      {needsTotp && openCount > 0 && (
        <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
          Clearing a check needs a session signed in with two-factor authentication.
        </p>
      )}
      {!error && flags === null && (
        <p role="status" className="mt-3 text-sm text-[var(--cf-text-muted)]">Loading credit checks...</p>
      )}
      {!error && flags?.length === 0 && (
        <p className="mt-3 text-sm text-[var(--cf-text-muted)]">No credit-check flags.</p>
      )}
      {flags && GROUPS.map(({ check, heading }) => {
        const group = flags.filter((f) => f.check === check)
        if (group.length === 0) return null
        return (
          <div key={check} className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{heading}</h3>
            <div className="mt-2 space-y-3">
              {group.map((flag) => (
                <div
                  key={flag.id}
                  data-testid="credit-check-flag"
                  className="rounded-md border border-[var(--cf-border-subtle)] p-3"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={flag.status === "OPEN" ? "warning" : flag.status === "CLEARED" ? "success" : "secondary"}>
                      {flag.status === "OPEN" ? "Open" : flag.status === "CLEARED" ? "Cleared" : "Superseded"}
                    </Badge>
                    <span className="font-mono text-xs text-[var(--cf-text-muted)]">{flag.code}</span>
                  </div>
                  <p className="mt-2 text-sm text-[var(--cf-text)]">{flag.summary}</p>
                  <Evidence flag={flag} />
                  {flag.status === "CLEARED" && (
                    <p className="mt-2 text-xs text-[var(--cf-text-secondary)]">
                      Cleared by {flag.clearedByName ?? "unknown"}
                      {flag.clearedAt ? ` on ${sastDate(flag.clearedAt)}` : ""}: {flag.clearReason}
                    </p>
                  )}
                  {flag.status === "OPEN" && canClear && (
                    <div className="mt-3">
                      <ClearForm applicationId={applicationId} flagId={flag.id} onDone={onCleared} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
