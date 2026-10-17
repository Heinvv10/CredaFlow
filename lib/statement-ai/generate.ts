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
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import { allowedFrom, explanationFacts, summaryFacts, type Built } from "./facts"
import { flagSpec } from "./flag-specs"
import { askModel } from "./model"
import { postCheck, type FlagSpec } from "./post-check"
import { cleanText, EXPLANATION_PROMPT_VERSION, explanationPrompt, SUMMARY_PROMPT_VERSION, summaryPrompt } from "./prompts"
import { storeOutput } from "./store"

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
 * The outputs an application's current facts call for, with their keys.
 * Null when the application is not this tenant's; no plans while no statement is read.
 */
export async function planOutputs(tenantId: string, applicationId: string): Promise<{ plans: Planned[]; documentIds: string[] } | null> {
  const loaded = await applicationStatementInsights(tenantId, applicationId)
  if (!loaded) return null
  if (loaded.read.length === 0) return { plans: [], documentIds: [] }
  const flags = await prisma.applicationCheckFlag.findMany({
    where: { tenantId, applicationId, status: "OPEN" },
    select: { code: true, check: true, evidence: true },
    orderBy: [{ code: "asc" }, { raisedAt: "asc" }],
  })
  const used = loaded.read.filter((s) => s.balanceCheck === "PASS")
  const rows = used.flatMap((s) => (s.read?.transactions ?? []).map((t) => ({ t })))
  const summary = summaryFacts(loaded.insights, rows, flags)
  const plans: Planned[] = [{
    kind: "SUMMARY", flagCode: "", promptVersion: SUMMARY_PROMPT_VERSION, built: summary,
    prompt: summaryPrompt(summary.facts), maxTokens: 600,
  }]
  const refOf = new Map(loaded.insights.statements.map((s, i) => [s.documentId, `S${i + 1}`]))
  const txOf = await evidenceTransactions(tenantId, flags)
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
  return { plans, documentIds: loaded.read.map((s) => s.documentId) }
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

/**
 * Asks the model for one planned output (up to ATTEMPTS times while the
 * post-check rejects it) and stores the result. Throws VlmUnavailableError
 * when the model cannot be asked: nothing is stored, and it is asked again
 * when the application is next viewed.
 */
export async function generate(tenantId: string, applicationId: string, plan: Planned): Promise<void> {
  let reason = ""
  let text = ""
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await askModel({ tenantId, applicationId, kind: plan.kind, prompt: plan.prompt, maxTokens: plan.maxTokens })
    text = cleanText(answer.content)
    const checked = postCheck({ text, allowed: plan.built.allowed, raisedFlagCodes: plan.built.raisedFlagCodes, flag: plan.flag })
    if (checked.ok) {
      await storeOutput({ tenantId, applicationId, kind: plan.kind, flagCode: plan.flagCode, inputHash: plan.built.inputHash, promptVersion: plan.promptVersion, status: "OK", text, citations: { facts: plan.built.facts } })
      return
    }
    reason = checked.reason
  }
  await storeOutput({ tenantId, applicationId, kind: plan.kind, flagCode: plan.flagCode, inputHash: plan.built.inputHash, promptVersion: plan.promptVersion, status: "REJECTED", rejectReason: reason, text, citations: { facts: plan.built.facts } })
}
