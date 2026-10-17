/**
 * What the staff UI is sent. Text only for an OK output: a REJECTED or
 * FAILED one is "unavailable", whatever it said. An output made from facts
 * that have since changed is still shown, marked stale, until the current
 * one exists.
 */
import type { StatementAiOutput } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { Planned } from "./generate"

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
}

export function toView(o: StatementAiOutput, currentHash: string | null): OutputView {
  const ok = o.status === "OK"
  return {
    id: o.id,
    kind: o.kind,
    flagCode: o.flagCode || null,
    status: o.status,
    text: ok ? o.text : null,
    inputHash: o.inputHash,
    promptVersion: o.promptVersion,
    createdAt: o.updatedAt.toISOString(),
    stale: currentHash !== null && o.inputHash !== currentHash,
    citations: ok ? o.citations : null,
  }
}

export interface ApplicationAiView {
  summary: OutputView | null
  explanations: OutputView[]
  /** Outputs the current facts call for that are not stored yet. */
  pending: number
}

/**
 * Per (kind, flag): the output for the current facts and prompt if stored,
 * else the newest older one (stale). Flags no longer raised are not shown.
 */
export async function applicationAiView(tenantId: string, applicationId: string, plans: Planned[]): Promise<ApplicationAiView> {
  const rows = await prisma.statementAiOutput.findMany({
    where: { tenantId, applicationId, kind: { in: ["SUMMARY", "FLAG_EXPLANATION"] } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  })
  let pending = 0
  const pick = (plan: Planned): OutputView | null => {
    const mine = rows.filter((r) => r.kind === plan.kind && r.flagCode === plan.flagCode)
    const current = mine.find((r) => r.inputHash === plan.built.inputHash && r.promptVersion === plan.promptVersion)
    if (current) return toView(current, plan.built.inputHash)
    pending++
    const older = mine.find((r) => r.status === "OK")
    return older ? toView(older, plan.built.inputHash) : null
  }
  const summaryPlan = plans.find((p) => p.kind === "SUMMARY")
  const summary = summaryPlan ? pick(summaryPlan) : null
  const explanations = plans.filter((p) => p.kind === "FLAG_EXPLANATION").map(pick).filter((v): v is OutputView => v !== null)
  return { summary, explanations, pending }
}
