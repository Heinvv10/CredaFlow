/**
 * Feature C's tools: typed, read-only queries over one application's
 * persisted statement rows, the same rows the insights count (reconciled
 * statements, overlapping days once). The model picks a tool and its
 * arguments; this code computes the figure. No SQL is built from the model's
 * text: arguments are validated (zod) and applied in memory to rows already
 * loaded for this tenant and application.
 */
import { z } from "zod"
import { categorise } from "@/lib/statement-analysis/categorise"
import { LIVING_CATEGORIES, OTHER_CATEGORIES, type Category } from "@/lib/statement-analysis/categories"
import { labelKey } from "@/lib/statement-analysis/model-labels"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { safeKey } from "../facts"
import { rand } from "../format"

export const CATEGORY_NAMES = [...LIVING_CATEGORIES, ...OTHER_CATEGORIES] as [Category, ...Category[]]
const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
const rands = z.number().finite().nonnegative().max(100_000_000)

export const FilterSchema = z.object({
  direction: z.enum(["in", "out"]).optional(),
  category: z.enum(CATEGORY_NAMES).optional(),
  payee: z.string().min(1).max(80).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  minAmount: rands.optional(),
  maxAmount: rands.optional(),
}).strict()

export const QuerySchema = z.discriminatedUnion("tool", [
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("sum"), filter: FilterSchema }).strict(),
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("count"), filter: FilterSchema }).strict(),
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("average"), filter: FilterSchema }).strict(),
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("groupByMonth"), filter: FilterSchema, measure: z.enum(["sum", "count"]) }).strict(),
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("groupByPayee"), filter: FilterSchema, measure: z.enum(["sum", "count"]), limit: z.number().int().min(1).max(10) }).strict(),
  z.object({ id: z.string().regex(/^q[1-9]$/), tool: z.literal("list"), filter: FilterSchema, limit: z.number().int().min(1).max(20) }).strict(),
])

export const MAX_QUERIES = 4
export const PlanSchema = z.object({ queries: z.array(QuerySchema).max(MAX_QUERIES) }).strict()

export type Filter = z.infer<typeof FilterSchema>
export type Query = z.infer<typeof QuerySchema>

/** One countable row: its reference (S1-R12: statement 1, row 12), masked payee and category. */
export interface AskRow {
  ref: string
  date: string
  payee: string
  amountCents: number
  category: Category
}

/** Rows listed under a figure, so the officer sees what it counted. */
export const ROWS_CITED = 20

export type MatchedRow = { ref: string; date: string; payee: string; amount: string }

export interface QueryResult {
  id: string
  tool: Query["tool"]
  /** The arguments as validated, amounts written as rand strings. */
  args: Record<string, unknown>
  /** The figures, formatted as the answer must copy them. */
  result: Record<string, unknown> | Array<Record<string, unknown>>
  matchedRows: number
  rows: MatchedRow[]
}

/** The rows of `statements` the tools may read, in statement order. */
export function askRows(
  statements: Array<{ ref: string; transactions: Array<{ index: number; t: StatementTransaction }>; modelLabels?: unknown }>,
  clientName: string | null,
): AskRow[] {
  return statements.flatMap((s) => s.transactions.map(({ index, t }) => {
    const key = labelKey(t.description)
    return {
      ref: `${s.ref}-R${index}`,
      date: t.date,
      payee: safeKey(key) ? key : "(payee withheld)",
      amountCents: t.amountCents,
      category: categorise(t, { clientName, modelLabels: s.modelLabels }).category,
    }
  }))
}

/**
 * The payee a filter names, as a payee the rows have: exactly, or the one
 * payee whose words include all of it ("BLUEGUM MILLS" → "SALARY BLUEGUM
 * MILLS"). Null when none or several do: a filter on a payee the rows do
 * not have would count nothing and still read as an answer.
 */
export function resolvePayee(given: string, payees: Iterable<string>): string | null {
  const want = given.trim().toUpperCase().split(/\s+/).filter(Boolean)
  const all = [...new Set(payees)]
  if (all.includes(want.join(" "))) return want.join(" ")
  const hits = all.filter((p) => want.every((w) => p.split(" ").includes(w)))
  return hits.length === 1 ? hits[0] : null
}

function matches(r: AskRow, f: Filter): boolean {
  const abs = Math.abs(r.amountCents)
  return (!f.direction || (f.direction === "in" ? r.amountCents > 0 : r.amountCents < 0)) &&
    (!f.category || r.category === f.category) &&
    (!f.payee || r.payee === f.payee.trim().toUpperCase()) &&
    (!f.from || r.date >= f.from) &&
    (!f.to || r.date <= f.to) &&
    (f.minAmount === undefined || abs >= Math.round(f.minAmount * 100)) &&
    (f.maxAmount === undefined || abs <= Math.round(f.maxAmount * 100))
}

/** A sum is of money in, money out (as a size), or net when the filter names no direction. */
const total = (rows: AskRow[], f: Filter) => {
  const net = rows.reduce((s, r) => s + r.amountCents, 0)
  return f.direction === "out" ? -net : net
}

function shownArgs(q: Query): Record<string, unknown> {
  const { id: _id, tool: _tool, ...rest } = q
  const filter = { ...q.filter } as Record<string, unknown>
  if (q.filter.minAmount !== undefined) filter.minAmount = rand(Math.round(q.filter.minAmount * 100))
  if (q.filter.maxAmount !== undefined) filter.maxAmount = rand(Math.round(q.filter.maxAmount * 100))
  return { ...rest, filter }
}

const cite = (rows: AskRow[]): MatchedRow[] => rows.slice(0, ROWS_CITED).map((r) => ({ ref: r.ref, date: r.date, payee: r.payee, amount: rand(r.amountCents) }))

export function runQuery(rows: AskRow[], q: Query): QueryResult {
  const hit = rows.filter((r) => matches(r, q.filter))
  const base = { id: q.id, tool: q.tool, args: shownArgs(q), matchedRows: hit.length, rows: cite(hit) }
  switch (q.tool) {
    case "sum":
      return { ...base, result: { total: rand(total(hit, q.filter)), rowCount: hit.length } }
    case "count":
      return { ...base, result: { count: hit.length } }
    case "average":
      return { ...base, result: { average: hit.length ? rand(Math.round(total(hit, q.filter) / hit.length)) : null, rowCount: hit.length } }
    case "groupByMonth":
    case "groupByPayee": {
      const keyOf = (r: AskRow) => (q.tool === "groupByMonth" ? r.date.slice(0, 7) : r.payee)
      const groups = new Map<string, AskRow[]>()
      for (const r of hit) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r])
      let entries = [...groups.entries()].map(([k, g]) => ({ k, sum: total(g, q.filter), count: g.length }))
      if (q.tool === "groupByMonth") entries.sort((a, b) => a.k.localeCompare(b.k))
      else {
        entries.sort((a, b) => (q.measure === "sum" ? Math.abs(b.sum) - Math.abs(a.sum) : b.count - a.count) || a.k.localeCompare(b.k))
        entries = entries.slice(0, q.limit)
      }
      const name = q.tool === "groupByMonth" ? "month" : "payee"
      return { ...base, result: entries.map((e) => (q.measure === "sum" ? { [name]: e.k, total: rand(e.sum), rowCount: e.count } : { [name]: e.k, count: e.count })) }
    }
    case "list":
      return { ...base, result: cite(hit.slice(0, q.limit)) }
  }
}
