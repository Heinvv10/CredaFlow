import { breakdownTitle, describeFilter, type Breakdown } from "@/lib/statement-ai/words"

export interface EvidenceRow { ref: string; date: string; payee: string; amount: string; direction?: "in" | "out" }

export interface QueryCitation {
  id: string
  tool: "sum" | "count" | "average" | "groupByMonth" | "groupByPayee" | "list"
  args: { filter?: Record<string, unknown>; measure?: string; limit?: number; order?: string }
  result: unknown
  matchedRows: number
  rows: EvidenceRow[]
}

const cell = "py-1 pr-3 align-top"
const num = `${cell} whitespace-nowrap text-right tabular-nums`

/** An amount as a size and the way it moved, as the answers write it: "R6 500.00 out", never "-R6 500.00". */
const way = (r: EvidenceRow) => {
  const out = r.direction ? r.direction === "out" : r.amount.startsWith("-")
  return `${r.amount.replace(/^-/, "")} ${out ? "out" : "in"}`
}

/** On a phone the date and row columns are hidden; both show under the payee instead. */
const OnPhone = ({ children }: { children: React.ReactNode }) => <span className="block text-xs text-[var(--cf-text-muted)] sm:hidden">{children}</span>

export function RowsTable({ rows }: { rows: EvidenceRow[] }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table aria-label="Statement rows" className="w-full min-w-0 text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.ref} className="border-t border-[var(--cf-border-subtle)]">
              <td className={`${cell} hidden whitespace-nowrap sm:table-cell`}>{r.date}</td>
              <td className={cell}>{r.payee}<OnPhone>{r.date} · {r.ref}</OnPhone></td>
              <td className={num}>{way(r)}</td>
              <td className={`${cell} hidden font-mono sm:table-cell text-[var(--cf-text-muted)]`}>{r.ref}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Entry = Record<string, string | number | undefined>

/** A breakdown or list as a table: the same figures the answer's text was written and checked from. */
function ResultTable({ q }: { q: QueryCitation }) {
  const entries = q.result as Entry[]
  const head = (cols: string[]) => (
    <thead>
      <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[var(--cf-text-muted)]">
        {cols.map((c, i) => <th key={c} scope="col" className={`pb-1 pr-3 font-medium ${(i > 0 && q.tool !== "list") || c === "Amount" ? "text-right" : ""} ${c === "Row" || c === "Date" ? "hidden sm:table-cell" : ""}`}>{c}</th>)}
      </tr>
    </thead>
  )
  const row = "border-t border-[var(--cf-border-subtle)]"
  return (
    <div className="mt-1 overflow-x-auto">
      <table aria-label={breakdownTitle(q as Breakdown)} className="w-full min-w-0 text-sm text-[var(--cf-text-secondary)]">
        {q.tool === "list" ? (
          <>
            {head(["Date", "Payee", "Amount", "Row"])}
            <tbody>
              {entries.map((e) => (
                <tr key={String(e.ref)} className={row}>
                  <td className={`${cell} hidden whitespace-nowrap sm:table-cell`}>{e.date}</td>
                  <td className={cell}>{e.payee}<OnPhone>{e.date} · {e.ref}</OnPhone></td>
                  <td className={num}>{e.amount} {e.direction}</td>
                  <td className={`${cell} hidden font-mono sm:table-cell text-xs text-[var(--cf-text-muted)]`}>{e.ref}</td>
                </tr>
              ))}
            </tbody>
          </>
        ) : (
          <>
            {head([q.tool === "groupByMonth" ? "Month" : "Payee", ...(entries.some((e) => e.total !== undefined) ? ["Total"] : []), "Rows"])}
            <tbody>
              {entries.map((e) => {
                const key = String(q.tool === "groupByMonth" ? e.month : e.payee)
                return (
                  <tr key={key} className={row}>
                    <td className={cell}>{key}</td>
                    {e.total !== undefined && <td className={num}>{e.total}{e.direction ? ` ${e.direction}` : ""}</td>}
                    <td className={num}>{e.total !== undefined ? e.rowCount : e.count}</td>
                  </tr>
                )
              })}
            </tbody>
          </>
        )}
      </table>
    </div>
  )
}

const isTable = (q: QueryCitation) => ["groupByMonth", "groupByPayee", "list"].includes(q.tool) && Array.isArray(q.result) && q.result.length > 0

/**
 * Each query's sentence from the stored (checked) text, by its [qN] label, or
 * null unless the text is exactly "[q1] … [q2] …" for these queries (as
 * render.ts writes it): then nothing of the checked text is dropped or put
 * under the wrong label.
 */
function segments(text: string, ids: string[]): Map<string, string> | null {
  const parts = text.trim().split(/\[(q\d)\] /)
  if (parts[0] !== "") return null
  const out = new Map<string, string>()
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1].trim())
  const rebuilt = [...out].map(([id, s]) => `[${id}] ${s}`).join(" ")
  return rebuilt === text.trim() && out.size === ids.length && ids.every((id) => /[A-Za-z0-9]/.test(out.get(id) ?? "")) ? out : null
}

/** The answer: a sentence for a single figure, a table for a breakdown or list; the [qN] label only when there are several. */
export function AnswerBody({ text, queries }: { text: string; queries: QueryCitation[] }) {
  const said = segments(text, queries.map((q) => q.id))
  if (!said) return <p className="text-sm text-[var(--cf-text-secondary)]">{text}</p>
  const labelled = queries.length > 1
  return (
    <div className="space-y-2">
      {queries.map((q) => (
        <div key={q.id} data-testid="statement-ai-part">
          {isTable(q) ? (
            <>
              <p className="text-sm text-[var(--cf-text-secondary)]">
                {labelled && <span className="mr-1 font-mono text-xs text-[var(--cf-text-muted)]">{q.id}</span>}
                {breakdownTitle(q as Breakdown)}:
              </p>
              <ResultTable q={q} />
              {q.tool === "list" && q.matchedRows > (q.result as Entry[]).length && (
                <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{q.matchedRows} rows match in all.</p>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--cf-text-secondary)]">
              {labelled && <span className="mr-1 font-mono text-xs text-[var(--cf-text-muted)]">{q.id}</span>}
              {said.get(q.id)}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

const DID: Record<QueryCitation["tool"], (q: QueryCitation) => string> = {
  sum: () => "Added up",
  count: () => "Counted",
  average: () => "Averaged",
  groupByMonth: (q) => `Grouped by month (${q.args.measure === "count" ? "number of rows" : "totals"})`,
  groupByPayee: (q) => `Ranked ${Array.isArray(q.result) && q.result.length === q.args.limit ? `the top ${q.args.limit} payees` : "payees"} by ${q.args.measure === "count" ? "number of rows" : "total"} in`,
  list: (q) => `Listed up to ${q.args.limit} rows${q.args.order === "largest" ? ", largest first," : q.args.order === "latest" ? ", latest first," : ""} of`,
}

/** "How this was computed", in words: what each query did, over which rows, and the rows it counted. */
export function HowComputed({ queries }: { queries: QueryCitation[] }) {
  return (
    <details className="mt-2 text-xs text-[var(--cf-text-secondary)]">
      <summary className="cursor-pointer text-[var(--cf-brand)]">How this was computed</summary>
      <ul className="mt-1 space-y-2">
        {queries.map((q) => (
          <li key={q.id} data-testid="statement-ai-query">
            <p>
              {queries.length > 1 && <span className="mr-1 font-mono">{q.id}</span>}
              {DID[q.tool]?.(q) ?? q.tool} {describeFilter(q.args)}: {q.matchedRows} row{q.matchedRows === 1 ? "" : "s"} matched.
            </p>
            {q.tool !== "list" && q.rows.length > 0 && <RowsTable rows={q.rows} />}
            {q.tool !== "list" && q.matchedRows > q.rows.length && <p className="mt-1">First {q.rows.length} of {q.matchedRows} rows shown.</p>}
          </li>
        ))}
      </ul>
    </details>
  )
}
