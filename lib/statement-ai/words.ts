/**
 * Words shared by render.ts (server) and the staff card (browser): no
 * server-only imports here, so the card labels a query exactly as the answer
 * text does.
 */
import type { ListOrder, QueryResult } from "./ask/tools"

export const WITHHELD = "(payee withheld)"

/** A payee's name is statement text a client can write: always quoted, so it reads as a name, never as the sentence. */
export const quoted = (payee: unknown) => (payee === WITHHELD ? WITHHELD : `"${String(payee)}"`)

export function describeFilter(args: Record<string, unknown>): string {
  const f = (args.filter ?? {}) as Record<string, unknown>
  const parts = [f.direction === "in" ? "money in" : f.direction === "out" ? "money out" : "all rows"]
  if (typeof f.payee === "string") parts.push(`${f.direction === "in" ? "from" : f.direction === "out" ? "to" : "with"} ${quoted(f.payee)}`)
  if (typeof f.category === "string") parts.push(`in category ${f.category}`)
  if (typeof f.from === "string" && typeof f.to === "string") parts.push(`from ${f.from} to ${f.to}`)
  else if (typeof f.from === "string") parts.push(`from ${f.from}`)
  else if (typeof f.to === "string") parts.push(`up to ${f.to}`)
  if (typeof f.minAmount === "string") parts.push(`of ${f.minAmount} or more`)
  if (typeof f.maxAmount === "string") parts.push(`of ${f.maxAmount} or less`)
  return parts.join(" ")
}

const ORDER_LABEL: Record<ListOrder, string> = { date: ", earliest at the top", latest: ", latest at the top", largest: ", largest amount at the top" }

export type Breakdown = Pick<QueryResult, "tool" | "args" | "result">

/** The heading of a breakdown or list result: what was grouped or listed, and in what order. */
export function breakdownTitle(q: Breakdown): string {
  const what = describeFilter(q.args)
  if (q.tool === "list") return `Rows for ${what}${ORDER_LABEL[q.args.order as ListOrder] ?? ""}`
  const key = q.tool === "groupByMonth" ? "month" : "payee"
  const entries = q.result as Array<Record<string, unknown>>
  const net = entries.some((e) => e.total !== undefined) && !(q.args.filter as Record<string, unknown> | undefined)?.direction ? " (net totals: a minus means more went out than came in)" : ""
  const top = key === "payee" && entries.length === q.args.limit ? (q.args.limit === 1 ? ", the largest payee" : `, the largest ${q.args.limit} payees`) : ""
  return `By ${key} for ${what}${top}${net}`
}
