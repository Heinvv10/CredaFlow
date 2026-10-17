"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"

interface EvidenceRow { ref: string; date: string; payee: string; amount: string }

interface OutputView {
  id: string
  kind: "SUMMARY" | "FLAG_EXPLANATION" | "ANSWER"
  flagCode: string | null
  status: "PENDING" | "OK" | "REJECTED" | "FAILED"
  text: string | null
  inputHash: string
  createdAt: string
  stale: boolean
  citations: { facts?: { evidenceRows?: EvidenceRow[] } } | null
}

interface Payload {
  summary: OutputView | null
  explanations: OutputView[]
  pending: number
  noStatements: boolean
  modelAvailable: boolean
}

const POLL_MS = 5_000
/** Stop polling after this long: the worker may be down, and the card says so. */
const POLL_FOR_MS = 5 * 60_000

function Meta({ o }: { o: OutputView }) {
  return (
    <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">
      Input {o.inputHash.slice(0, 8)} · generated {new Date(o.createdAt).toLocaleString("en-ZA")}
      {o.stale && <span className="ml-1 font-medium text-[var(--cf-warning)]">· stale: the statement facts changed since</span>}
    </p>
  )
}

function Body({ o, waiting, label }: { o: OutputView | null; waiting: boolean; label: string }) {
  if (!o) return <p className="text-sm text-[var(--cf-text-muted)]">{waiting ? `Generating ${label}…` : `${label[0].toUpperCase()}${label.slice(1)} unavailable.`}</p>
  if (o.status !== "OK" || o.text === null) {
    return (
      <>
        <p className="text-sm text-[var(--cf-text-muted)]">{`${label[0].toUpperCase()}${label.slice(1)} unavailable.`}</p>
        <Meta o={o} />
      </>
    )
  }
  return (
    <>
      <p className="whitespace-pre-line text-sm text-[var(--cf-text-secondary)]">{o.text}</p>
      <Meta o={o} />
    </>
  )
}

export function StatementAiCard({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [off, setOff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gaveUp, setGaveUp] = useState(false)

  const load = useCallback(async (): Promise<Payload | null> => {
    try {
      const res = await fetch(`/api/applications/${applicationId}/statement-ai`, { cache: "no-store" })
      if (res.status === 404) {
        setOff(true)
        return null
      }
      if (!res.ok) {
        setError("Could not load the AI summary.")
        return null
      }
      const body = (await res.json()) as Payload
      setData(body)
      setError(null)
      return body
    } catch {
      setError("Network error. Could not load the AI summary.")
      return null
    }
  }, [applicationId])

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const since = Date.now()
    const tick = async () => {
      const body = await load()
      if (!live || !body || body.pending === 0 || !body.modelAvailable) return
      if (Date.now() - since < POLL_FOR_MS) timer = setTimeout(tick, POLL_MS)
      else setGaveUp(true)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [load])

  if (off) return null
  const waiting = !!data && data.pending > 0 && data.modelAvailable && !gaveUp

  return (
    <section data-testid="statement-ai-card" className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[var(--cf-text)]">AI summary</h2>
        <Badge variant="secondary">Advisory: the credit checks decide</Badge>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--cf-danger)]">{error}</p>}
      {!error && !data && <p role="status" className="mt-3 text-sm text-[var(--cf-text-muted)]">Loading the AI summary...</p>}
      {data?.noStatements && <p className="mt-3 text-sm text-[var(--cf-text-muted)]">No statement has been read yet.</p>}
      {data && !data.noStatements && (
        <div className="mt-3 space-y-4">
          <div data-testid="statement-ai-summary">
            <Body o={data.summary} waiting={waiting} label="summary" />
          </div>
          {data.explanations.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">Flags explained</h3>
              <ul className="mt-2 space-y-3">
                {data.explanations.map((o) => (
                  <li key={o.id} data-testid="statement-ai-explanation" className="rounded-md border border-[var(--cf-border-subtle)] p-3">
                    <p className="font-mono text-xs font-semibold text-[var(--cf-text)]">{o.flagCode}</p>
                    <div className="mt-1"><Body o={o} waiting={waiting} label="explanation" /></div>
                    {o.status === "OK" && (o.citations?.facts?.evidenceRows?.length ?? 0) > 0 && (
                      <details className="mt-2 text-xs text-[var(--cf-text-secondary)]">
                        <summary className="cursor-pointer text-[var(--cf-brand)]">Rows cited</summary>
                        <div className="mt-1 overflow-x-auto">
                          <table className="w-full min-w-[320px]">
                            <tbody>
                              {o.citations!.facts!.evidenceRows!.map((r) => (
                                <tr key={r.ref} className="border-t border-[var(--cf-border-subtle)]">
                                  <td className="py-1 pr-2 font-mono">{r.ref}</td>
                                  <td className="py-1 pr-2 whitespace-nowrap">{r.date}</td>
                                  <td className="py-1 pr-2">{r.payee}</td>
                                  <td className="py-1 text-right whitespace-nowrap">{r.amount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!data.modelAvailable && data.pending > 0 && <p className="text-xs text-[var(--cf-text-muted)]">The model is not available right now; outputs will be generated when it is.</p>}
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--cf-text-muted)]">Written by a language model from the figures above. Every figure is checked against them before it is shown; it never changes a flag or the decision.</p>
    </section>
  )
}
