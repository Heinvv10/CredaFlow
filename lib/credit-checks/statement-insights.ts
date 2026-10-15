/**
 * An application's statement insights: the same statements, in the same
 * window, as the credit checks read (load-facts.ts), so the panel, the export
 * and the decide route's `checks_stale` comparison all see one set. Reads
 * only what is persisted; it never runs a reader inside a staff request.
 */
import { computeInsights, type Insights } from "@/lib/statement-analysis/insights"
import { loadApplicationFacts } from "./load-facts"
import type { ApplicationFacts, StatementFacts } from "./types"

export interface ApplicationInsights {
  facts: ApplicationFacts
  insights: Insights
  /** The read statements the figures summarise: showing them is document access. */
  read: StatementFacts[]
  /** Statements in the window not read yet (pending, unreadable): not in the figures. */
  unread: number
}

export async function applicationStatementInsights(tenantId: string, applicationId: string): Promise<ApplicationInsights | null> {
  const loaded = await loadApplicationFacts(tenantId, applicationId, { persistedOnly: true })
  if (!loaded) return null
  const { facts } = loaded
  const read = facts.statements.filter((s) => s.state === "READ" && s.read)
  const insights = computeInsights(
    read.map((s) => ({ documentId: s.documentId, bank: s.bank, balanceCheck: s.balanceCheck, read: s.read!, modelLabels: s.modelLabels })),
    { clientName: facts.clientName, declaredExpensesCents: facts.declaredExpensesCents ?? null },
  )
  return { facts, insights, read, unread: facts.statements.length - read.length }
}
