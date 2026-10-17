/**
 * What the staff UI is sent. Text only for an OK output: a REJECTED or
 * FAILED one is "unavailable", whatever it said. An output made from facts
 * that have since changed is still shown, marked stale, until the current
 * one exists.
 */
import type { StatementAiOutput } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ApplicationPlan } from "./generate"
import { checkNoContradiction } from "./post-check"
import { askInputHash } from "./ask/answer"

export interface OutputView {
  id: string
  kind: StatementAiOutput["kind"]
  flagCode: string | null
  status: StatementAiOutput["status"]
  /** Null unless status is OK. */
  text: string | null
  inputHash: string
  promptVersion: string
  createdAt: string
  /** Made from facts that have changed since. */
  stale: boolean
  /** OK outputs only: what the text was made from. */
  citations: unknown
  /** ANSWER only. */
  question: string | null
}

/**
 * `raisedFlagCodes` are the flags raised now: an output checked when fewer
 * were raised ("spend looks normal" with none) is shown only if it would pass
 * the language check today.
 */
export function toView(o: StatementAiOutput, currentHash: string | null, raisedFlagCodes: readonly string[]): OutputView {
  const ok = o.status === "OK" && checkNoContradiction(o.text, raisedFlagCodes).ok
  return {
    id: o.id,
    kind: o.kind,
    flagCode: o.flagCode || null,
    status: ok || o.status !== "OK" ? o.status : "REJECTED",
    text: ok ? o.text : null,
    inputHash: o.inputHash,
    promptVersion: o.promptVersion,
    createdAt: o.updatedAt.toISOString(),
    stale: currentHash !== null && o.inputHash !== currentHash,
    citations: ok ? o.citations : null,
    question: o.question,
  }
}

export interface ApplicationAiView {
  summary: OutputView | null
  explanations: OutputView[]
  /** The newest answers first; a PENDING one is still being worked on. */
  answers: OutputView[]
  /** Outputs the current facts call for that are not stored yet. */
  pending: number
}

/**
 * The summary for the current facts and prompt if stored, else the newest
 * older OK one (stale); the explanations as code writes them now; the newest
 * answers.
 */
export const ANSWERS_SHOWN = 10

export async function applicationAiView(
  tenantId: string,
  applicationId: string,
  plan: Pick<ApplicationPlan, "summary" | "explanations" | "rows" | "raisedFlagCodes">,
  opts: { summaries: boolean },
): Promise<ApplicationAiView> {
  const { rows: askRows, raisedFlagCodes } = plan
  let pending = 0
  let summary: OutputView | null = null
  // The summary and explanations restate the statement insights: shown only to those who see those (CREDIT_OFFICER and up).
  if (opts.summaries && plan.summary) {
    const want = plan.summary
    const mine = await prisma.statementAiOutput.findMany({
      where: { tenantId, applicationId, kind: "SUMMARY" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    })
    const current = mine.find((r) => r.inputHash === want.built.inputHash && r.promptVersion === want.promptVersion)
    if (!current) pending++
    const shown = current ?? mine.find((r) => r.status === "OK")
    summary = shown ? toView(shown, want.built.inputHash, raisedFlagCodes) : null
  }
  const now = new Date().toISOString()
  const explanations: OutputView[] = opts.summaries
    ? plan.explanations.map((e, i) => ({
        id: `flag:${i}:${e.flagCode}`, kind: "FLAG_EXPLANATION", flagCode: e.flagCode, status: e.text === null ? "REJECTED" : "OK", text: e.text,
        inputHash: e.inputHash, promptVersion: "template", createdAt: now, stale: false, citations: e.text === null ? null : { facts: e.facts }, question: null,
      }))
    : []
  const asked = await prisma.statementAiOutput.findMany({
    where: { tenantId, applicationId, kind: "ANSWER" },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: ANSWERS_SHOWN,
  })
  const answers = asked.map((a) => toView(a, askInputHash(a.question ?? "", askRows), raisedFlagCodes))
  pending += answers.filter((a) => a.status === "PENDING").length
  return { summary, explanations, answers, pending }
}
