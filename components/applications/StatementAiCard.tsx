"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"

interface EvidenceRow { ref: string; date: string; payee: string; amount: string; direction?: "in" | "out" }

interface QueryCitation {
  id: string
  tool: string
  args: { filter?: Record<string, unknown>; measure?: string; limit?: number }
  result: unknown
  matchedRows: number
  rows: EvidenceRow[]
}

interface OutputView {
  id: string
  kind: "SUMMARY" | "FLAG_EXPLANATION" | "ANSWER"
  flagCode: string | null
  status: "PENDING" | "OK" | "REJECTED" | "FAILED"
  text: string | null
  inputHash: string
  createdAt: string
  stale: boolean
  citations: ({ facts?: { evidenceRows?: EvidenceRow[] } } & QueryCitation[]) | null
  question: string | null
}

interface Payload {
  summary: OutputView | null
  explanations: OutputView[]
  answers: OutputView[]
  pending: number
  noStatements: boolean
  /** The role may not see the summary and explanations (READONLY): they are not shown at all. */
  summaryWithheld?: boolean
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
  if (!o || (o.status === "PENDING" && o.text === null)) return <p className="text-sm text-[var(--cf-text-muted)]">{waiting ? `Generating ${label}…` : `${label[0].toUpperCase()}${label.slice(1)} unavailable.`}</p>
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

function RowsTable({ rows }: { rows: EvidenceRow[] }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full min-w-0">
        <tbody>
          {rows.map((r) => (
            <tr key={r.ref} className="border-t border-[var(--cf-border-subtle)]">
              <td className="py-1 pr-2 font-mono">{r.ref}</td>
              <td className="py-1 pr-2 whitespace-nowrap">{r.date}</td>
              <td className="py-1 pr-2">{r.payee}</td>
              <td className="py-1 text-right whitespace-nowrap">{r.amount}{r.direction ? ` ${r.direction}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const describeFilter = (f: Record<string, unknown> = {}) =>
  Object.entries(f).map(([k, v]) => `${k} ${String(v)}`).join(", ") || "all rows"

/** "How this was computed": each query the answer used, its result and the rows it matched. */
function HowComputed({ queries }: { queries: QueryCitation[] }) {
  return (
    <details className="mt-2 text-xs text-[var(--cf-text-secondary)]">
      <summary className="cursor-pointer text-[var(--cf-brand)]">How this was computed</summary>
      <ul className="mt-1 space-y-2">
        {queries.map((q) => (
          <li key={q.id} data-testid="statement-ai-query">
            <p>
              <span className="font-mono font-semibold">[{q.id}]</span> {q.tool}
              {q.args.measure ? ` (${q.args.measure})` : ""} of {describeFilter(q.args.filter)}: {q.matchedRows} row{q.matchedRows === 1 ? "" : "s"} matched
            </p>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{JSON.stringify(q.result)}</pre>
            {q.rows.length > 0 && <RowsTable rows={q.rows} />}
            {q.matchedRows > q.rows.length && <p className="mt-1">First {q.rows.length} of {q.matchedRows} rows shown.</p>}
          </li>
        ))}
      </ul>
    </details>
  )
}

function Ask({ applicationId, onAsked }: { applicationId: string; onAsked: () => void }) {
  const [question, setQuestion] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/statement-ai/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (res.ok) {
        setQuestion("")
        onAsked()
      } else setMessage(body.error ?? "Could not ask the question.")
    } catch {
      setMessage("Network error. Could not ask the question.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor="statement-ai-question" className="sr-only">Ask the statement</label>
      <input
        id="statement-ai-question"
        value={question}
        maxLength={300}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="e.g. How much was paid to the landlord in total?"
        className="min-w-0 flex-1 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface)] px-3 py-2 text-sm text-[var(--cf-text)]"
      />
      <button type="submit" disabled={busy || question.trim().length < 3} className="rounded-md bg-[var(--cf-brand)] px-3 py-2 text-sm font-medium text-[var(--cf-on-brand)] disabled:opacity-50">
        {busy ? "Asking…" : "Ask"}
      </button>
      {message && <p role="alert" className="text-sm text-[var(--cf-danger)]">{message}</p>}
    </form>
  )
}

export function StatementAiCard({ applicationId, canAsk = false }: { applicationId: string; canAsk?: boolean }) {
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

  const [askedAt, setAskedAt] = useState(0)

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
  }, [load, askedAt])

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
          {!data.summaryWithheld && (
            <div data-testid="statement-ai-summary">
              <Body o={data.summary} waiting={waiting} label="summary" />
            </div>
          )}
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
                        <RowsTable rows={o.citations!.facts!.evidenceRows!} />
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">Ask the statement</h3>
            {canAsk && <div className="mt-2"><Ask applicationId={applicationId} onAsked={() => { setGaveUp(false); setAskedAt(Date.now()) }} /></div>}
            {data.answers.length === 0 && <p className="mt-2 text-sm text-[var(--cf-text-muted)]">No questions asked yet.</p>}
            <ul className="mt-2 space-y-3">
              {data.answers.map((o) => (
                <li key={o.id} data-testid="statement-ai-answer" className="rounded-md border border-[var(--cf-border-subtle)] p-3">
                  <p className="text-sm font-medium text-[var(--cf-text)]">{o.question}</p>
                  <div className="mt-1">
                    {o.status === "PENDING"
                      ? <p className="text-sm text-[var(--cf-text-muted)]">Working it out…</p>
                      : <Body o={o} waiting={false} label="answer" />}
                  </div>
                  {o.status === "OK" && Array.isArray(o.citations) && <HowComputed queries={o.citations} />}
                </li>
              ))}
            </ul>
          </div>
          {!data.modelAvailable && data.pending > 0 && <p className="text-xs text-[var(--cf-text-muted)]">The model is not available right now; outputs will be generated when it is.</p>}
        </div>
      )}
      <p className="mt-3 text-[11px] text-[var(--cf-text-muted)]">The model only chooses what to show; every sentence is written from the statement figures. Every figure is checked against them before it is shown; it never changes a flag or the decision.</p>
    </section>
  )
}
