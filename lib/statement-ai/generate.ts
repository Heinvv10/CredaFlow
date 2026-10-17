/**
 * Features A and B. A, the summary, is made in the background (worker.ts) for
 * a tenant with Statement AI on: the model chooses claims, code writes them
 * (render.ts). It is keyed by (input hash, prompt version): facts already
 * summarised are not asked again, and changed facts make a new row (the old
 * one shows as stale). B, the flag explanations, need no model: code writes
 * them from each flag's facts whenever they are shown.
 */
import type { ApplicationCheckFlag } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { applicationStatementInsights } from "@/lib/credit-checks/statement-insights"
import { distinctRows, type CountedRow, type Insights } from "@/lib/statement-analysis/insights"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { parseVlmResponse } from "@/lib/vlm-extract"
import { explanationFacts, summaryFacts, type Built, type ExplanationFacts, type SummaryFacts } from "./facts"
import { askModel } from "./model"
import { checkFigures } from "./post-check"
import { cleanText, SUMMARY_PROMPT_VERSION, summaryPrompt } from "./prompts"
import { ClaimsSchema, renderExplanation, renderSummary } from "./render"
import { storeOutput } from "./store"
import { askRows, type AskRow } from "./ask/tools"

/** An answer that is not a valid claims list is asked once more. */
export const ATTEMPTS = 2

export interface Planned {
  kind: "SUMMARY"
  flagCode: ""
  promptVersion: string
  built: Built<SummaryFacts>
  prompt: string
  maxTokens: number
}

/** A flag's explanation, written by code: shown as it is, never stored. */
export interface Explanation {
  flagCode: string
  /** Null only if the rendered text failed its figure check (a bug: never shown). */
  text: string | null
  inputHash: string
  facts: ExplanationFacts
}

/**
 * The summary to ask for and the explanations to show, for some facts: a pure
 * function, so the evaluation (scripts/statement-ai/eval.ts) plans exactly
 * what the worker does. `rows` are the counted rows (insights.ts
 * distinctRows); `txOf` each flag's evidence read, by analysis id.
 */
export function buildPlans(
  insights: Insights,
  rows: CountedRow[],
  flags: Array<Pick<ApplicationCheckFlag, "code" | "check" | "evidence">>,
  txOf: Map<string, StatementTransaction[]>,
  clientName: string | null,
): { summary: Planned; explanations: Explanation[] } {
  const built = summaryFacts(insights, rows, flags, clientName)
  const summary: Planned = { kind: "SUMMARY", flagCode: "", promptVersion: SUMMARY_PROMPT_VERSION, built, prompt: summaryPrompt(built.facts), maxTokens: 200 }
  const refOf = new Map(insights.statements.map((s, i) => [s.documentId, `S${i + 1}`]))
  const explanations: Explanation[] = []
  // One explanation per flag: one code can be raised several times (each counterparty, each month).
  for (const flag of flags) {
    const e = (flag.evidence ?? {}) as Record<string, unknown>
    const all = typeof e.analysisId === "string" ? txOf.get(e.analysisId) ?? [] : []
    const ref = typeof e.documentId === "string" ? refOf.get(e.documentId) ?? "S?" : "S?"
    const indexes = Array.isArray(e.transactionIndexes) ? (e.transactionIndexes as unknown[]).filter((i): i is number => typeof i === "number") : []
    const evidenceRows = indexes.flatMap((index) => (all[index] ? [{ statementRef: ref, index, t: all[index] }] : []))
    const facts = explanationFacts(flag, evidenceRows, built.raisedFlagCodes, clientName)
    const text = renderExplanation(facts.facts)
    // Code wrote it from these facts, so every figure is theirs; the check is a guard against a bug here.
    const checked = checkFigures(text, { ...facts.allowed, literals: [...(facts.allowed.literals ?? []), ...built.raisedFlagCodes] })
    if (!checked.ok) console.error("[statement-ai] explanation failed its figure check:", { code: flag.code, reason: checked.reason })
    explanations.push({ flagCode: flag.code, text: checked.ok ? text : null, inputHash: facts.inputHash, facts: facts.facts })
  }
  return { summary, explanations }
}

export interface ApplicationPlan {
  /** Null while no statement is read. */
  summary: Planned | null
  explanations: Explanation[]
  /** The read statements: showing anything made from them is document access. */
  documentIds: string[]
  /** The rows a question may read (feature C), from the same load. */
  rows: AskRow[]
  raisedFlagCodes: string[]
}

/** Everything an application's current facts call for. Null when the application is not this tenant's. */
export async function planOutputs(tenantId: string, applicationId: string): Promise<ApplicationPlan | null> {
  const loaded = await applicationStatementInsights(tenantId, applicationId)
  if (!loaded) return null
  if (loaded.read.length === 0) return { summary: null, explanations: [], documentIds: [], rows: [], raisedFlagCodes: [] }
  const flags = await prisma.applicationCheckFlag.findMany({
    where: { tenantId, applicationId, status: "OPEN" },
    select: { code: true, check: true, evidence: true },
    orderBy: [{ code: "asc" }, { raisedAt: "asc" }],
  })
  const statements = loaded.read.map((s) => ({ documentId: s.documentId, bank: s.bank, balanceCheck: s.balanceCheck, read: s.read!, modelLabels: s.modelLabels }))
  const counted = distinctRows(statements.filter((s) => s.balanceCheck === "PASS"))
  const { summary, explanations } = buildPlans(loaded.insights, counted, flags, await evidenceTransactions(tenantId, flags), loaded.facts.clientName)
  return {
    summary,
    explanations,
    documentIds: loaded.read.map((s) => s.documentId),
    rows: countedAskRows(loaded.insights.statements.map((s) => s.documentId), counted, loaded.facts.clientName),
    raisedFlagCodes: [...new Set(flags.map((f) => f.code))].sort(),
  }
}

/** The counted rows as the question tools read them, each referenced as S<statement>-R<row index>. */
export function countedAskRows(order: string[], counted: CountedRow[], clientName: string | null): AskRow[] {
  return order.flatMap((documentId, i) => {
    const mine = counted.filter((c) => c.s.documentId === documentId)
    if (mine.length === 0) return []
    const all = mine[0].s.read.transactions
    return askRows([{ ref: `S${i + 1}`, transactions: mine.map((c) => ({ index: all.indexOf(c.t), t: c.t })), modelLabels: mine[0].s.modelLabels }], clientName)
  })
}

async function evidenceTransactions(tenantId: string, flags: Array<Pick<ApplicationCheckFlag, "evidence">>): Promise<Map<string, StatementTransaction[]>> {
  const ids = [...new Set(flags.map((f) => ((f.evidence ?? {}) as Record<string, unknown>).analysisId).filter((v): v is string => typeof v === "string"))]
  if (ids.length === 0) return new Map()
  const rows = await prisma.statementAnalysis.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, transactions: true } })
  return new Map(rows.map((r) => [r.id, r.transactions as unknown as StatementTransaction[]]))
}

/** Whether the summary for these facts and this prompt is stored yet. */
export async function summaryStored(tenantId: string, applicationId: string, plan: Planned): Promise<boolean> {
  const n = await prisma.statementAiOutput.count({
    where: { tenantId, applicationId, kind: "SUMMARY", flagCode: "", inputHash: plan.built.inputHash, promptVersion: plan.promptVersion },
  })
  return n > 0
}

/** Asks the model: production passes askModel (metered); the evaluation its own timed call. */
export type Ask = (prompt: string, maxTokens: number) => Promise<string>

export interface Produced {
  status: "OK" | "REJECTED"
  text: string
  rejectReason?: string
  claims?: string[]
}

/**
 * The summary: the model's claims (asked up to ATTEMPTS times while its answer
 * is not a valid claims list), written by code. Throws (VlmUnavailableError)
 * when the model cannot be asked.
 */
export async function produce(plan: Planned, ask: Ask): Promise<Produced> {
  let reason = ""
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const parsed = ClaimsSchema.safeParse(parseVlmResponse(cleanText(await ask(plan.prompt, plan.maxTokens))))
    if (!parsed.success) {
      reason = `invalid claims: ${parsed.error.issues[0]?.message ?? "shape"}`
      continue
    }
    const text = renderSummary(parsed.data.claims, plan.built.facts)
    if (!text) return { status: "REJECTED", text, rejectReason: "the chosen claims say nothing for these facts" }
    // Code wrote it from the facts; the figure check guards against a bug in render.ts.
    const checked = checkFigures(text, plan.built.allowed)
    if (!checked.ok) return { status: "REJECTED", text, rejectReason: `rendered summary failed its figure check: ${checked.reason}` }
    return { status: "OK", text, claims: parsed.data.claims }
  }
  return { status: "REJECTED", text: "", rejectReason: reason }
}

/**
 * Produces and stores the summary. When the model cannot be asked, nothing is
 * stored, and it is asked again when the application is next viewed.
 */
export async function generate(tenantId: string, applicationId: string, plan: Planned): Promise<void> {
  const out = await produce(plan, async (prompt, maxTokens) => (await askModel({ tenantId, applicationId, kind: "SUMMARY", prompt, maxTokens })).content)
  await storeOutput({
    tenantId, applicationId, kind: "SUMMARY", flagCode: "", inputHash: plan.built.inputHash, promptVersion: plan.promptVersion,
    status: out.status, rejectReason: out.rejectReason, text: out.text, citations: { facts: plan.built.facts, claims: out.claims ?? [] },
  })
}
