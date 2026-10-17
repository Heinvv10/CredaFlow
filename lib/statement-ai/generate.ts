/**
 * Features A and B: the summary and one explanation per raised flag, made in
 * the background (worker.ts) for a tenant with Statement AI on. Each output is
 * keyed by (kind, flag, input hash, prompt version): facts already answered
 * are not asked again, and changed facts make a new row (the old one shows
 * as stale). Every output is post-checked; a rejected one is stored with its
 * reason and never shown.
 */
import type { ApplicationCheckFlag, StatementAiKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { applicationStatementInsights } from "@/lib/credit-checks/statement-insights"
import { distinctRows, type CountedRow, type Insights } from "@/lib/statement-analysis/insights"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { allowedFrom, explanationFacts, summaryFacts, type Built } from "./facts"
import { flagSpec } from "./flag-specs"
import { askModel } from "./model"
import { postCheck, type FlagSpec } from "./post-check"
import { cleanText, EXPLANATION_PROMPT_VERSION, explanationPrompt, SUMMARY_PROMPT_VERSION, summaryPrompt } from "./prompts"
import { storeOutput } from "./store"
import { askRows, type AskRow } from "./ask/tools"

/** A rejected output is asked once more: the model is not deterministic at temperature 0. */
export const ATTEMPTS = 2

export interface Planned {
  kind: StatementAiKind
  flagCode: string
  promptVersion: string
  built: Built<unknown>
  prompt: string
  maxTokens: number
  flag?: FlagSpec
}


/**
 * The outputs some facts call for, with their keys: a pure function, so the
 * evaluation (scripts/statement-ai/eval.ts) plans exactly what the worker does.
 * `rows` are the counted rows (insights.ts distinctRows); `txOf` each flag's
 * evidence read, by analysis id.
 */
export function buildPlans(
  insights: Insights,
  rows: CountedRow[],
  flags: Array<Pick<ApplicationCheckFlag, "code" | "check" | "evidence">>,
  txOf: Map<string, StatementTransaction[]>,
): Planned[] {
  const summary = summaryFacts(insights, rows, flags)
  const plans: Planned[] = [{
    kind: "SUMMARY", flagCode: "", promptVersion: SUMMARY_PROMPT_VERSION, built: summary,
    prompt: summaryPrompt(summary.facts), maxTokens: 600,
  }]
  const refOf = new Map(insights.statements.map((s, i) => [s.documentId, `S${i + 1}`]))
  const seen = new Set<string>()
  for (const flag of flags) {
    // One explanation per code: two flags of one code (two statements) share it.
    if (seen.has(flag.code)) continue
    seen.add(flag.code)
    const e = (flag.evidence ?? {}) as Record<string, unknown>
    const all = typeof e.analysisId === "string" ? txOf.get(e.analysisId) ?? [] : []
    const ref = typeof e.documentId === "string" ? refOf.get(e.documentId) ?? "S?" : "S?"
    const indexes = Array.isArray(e.transactionIndexes) ? (e.transactionIndexes as unknown[]).filter((i): i is number => typeof i === "number") : []
    const evidenceRows = indexes.flatMap((index) => (all[index] ? [{ statementRef: ref, index, t: all[index] }] : []))
    const built = explanationFacts(flag, evidenceRows, summary.raisedFlagCodes)
    const spec = flagSpec(flag.code, flag.evidence)
    plans.push({
      kind: "FLAG_EXPLANATION", flagCode: flag.code, promptVersion: EXPLANATION_PROMPT_VERSION, built,
      prompt: explanationPrompt(built.facts), maxTokens: 400,
      flag: { code: flag.code, direction: spec.direction, thresholds: allowedFrom(spec.thresholds) },
    })
  }
  return plans
}

export interface ApplicationPlan {
  plans: Planned[]
  /** The read statements: showing anything made from them is document access. */
  documentIds: string[]
  /** The rows a question may read (feature C), from the same load. */
  rows: AskRow[]
  raisedFlagCodes: string[]
}

/**
 * The outputs an application's current facts call for, and the rows a
 * question may read. Null when the application is not this tenant's; no plans
 * and no rows while no statement is read.
 */
export async function planOutputs(tenantId: string, applicationId: string): Promise<ApplicationPlan | null> {
  const loaded = await applicationStatementInsights(tenantId, applicationId)
  if (!loaded) return null
  if (loaded.read.length === 0) return { plans: [], documentIds: [], rows: [], raisedFlagCodes: [] }
  const flags = await prisma.applicationCheckFlag.findMany({
    where: { tenantId, applicationId, status: "OPEN" },
    select: { code: true, check: true, evidence: true },
    orderBy: [{ code: "asc" }, { raisedAt: "asc" }],
  })
  const statements = loaded.read.map((s) => ({ documentId: s.documentId, bank: s.bank, balanceCheck: s.balanceCheck, read: s.read!, modelLabels: s.modelLabels }))
  const counted = distinctRows(statements.filter((s) => s.balanceCheck === "PASS"))
  const plans = buildPlans(loaded.insights, counted, flags, await evidenceTransactions(tenantId, flags))
  return {
    plans,
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

/** The plans with no stored output yet. */
export async function missing(tenantId: string, applicationId: string, plans: Planned[]): Promise<Planned[]> {
  const have = await prisma.statementAiOutput.findMany({
    where: { tenantId, applicationId, kind: { in: ["SUMMARY", "FLAG_EXPLANATION"] }, inputHash: { in: plans.map((p) => p.built.inputHash) } },
    select: { kind: true, flagCode: true, inputHash: true, promptVersion: true },
  })
  const key = (p: { kind: string; flagCode: string; inputHash: string; promptVersion: string }) => `${p.kind}|${p.flagCode}|${p.inputHash}|${p.promptVersion}`
  const stored = new Set(have.map(key))
  return plans.filter((p) => !stored.has(key({ ...p, inputHash: p.built.inputHash })))
}

/** Asks the model: production passes askModel (metered); the evaluation its own timed call. */
export type Ask = (prompt: string, maxTokens: number) => Promise<string>

export interface Produced {
  status: "OK" | "REJECTED"
  text: string
  rejectReason?: string
}

/**
 * One planned output, asked up to ATTEMPTS times while the post-check rejects
 * it. Throws (VlmUnavailableError) when the model cannot be asked.
 */
export async function produce(plan: Planned, ask: Ask): Promise<Produced> {
  let reason = ""
  let text = ""
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    text = cleanText(await ask(plan.prompt, plan.maxTokens))
    const checked = postCheck({ text, allowed: plan.built.allowed, raisedFlagCodes: plan.built.raisedFlagCodes, flag: plan.flag })
    if (checked.ok) return { status: "OK", text }
    reason = checked.reason
  }
  return { status: "REJECTED", text, rejectReason: reason }
}

/**
 * Produces and stores one planned output. When the model cannot be asked,
 * nothing is stored, and it is asked again when the application is next viewed.
 */
export async function generate(tenantId: string, applicationId: string, plan: Planned): Promise<void> {
  const out = await produce(plan, async (prompt, maxTokens) => (await askModel({ tenantId, applicationId, kind: plan.kind, prompt, maxTokens })).content)
  await storeOutput({
    tenantId, applicationId, kind: plan.kind, flagCode: plan.flagCode, inputHash: plan.built.inputHash, promptVersion: plan.promptVersion,
    status: out.status, rejectReason: out.rejectReason, text: out.text, citations: { facts: plan.built.facts },
  })
}
