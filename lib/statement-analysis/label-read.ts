import type { StatementAnalysis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { categorise } from "./categorise"
import { labelKey, labelKeys, needsModelLabels } from "./model-labels"
import type { StatementTransaction } from "./types"
import { VlmUnavailableError } from "./vlm-reader"

/**
 * Asks the model for the debits no rule categorises and stores its labels on
 * the read. Background only: called from persist.ts's queue, never inside a
 * request. True when labels were stored; a model that cannot be asked stores
 * nothing (the rules alone apply) and the read is labelled on a later run.
 */
export async function labelRead(tenantId: string, analysis: StatementAnalysis): Promise<boolean> {
  if (!needsModelLabels(analysis)) return false
  // The holder's name, as the rules see it on read: a transfer to their own
  // name is categorised by the rules and never sent.
  const ctx = { clientName: analysis.accountHolderName }
  const keys = (analysis.transactions as unknown as StatementTransaction[])
    .filter((t) => t.amountCents < 0 && !t.nonPosting && categorise(t, ctx).category === "UNCATEGORISED")
    .map((t) => labelKey(t.description))
  try {
    const labelled = await labelKeys(keys)
    const stored = await prisma.statementAnalysis.updateMany({
      where: { id: analysis.id, tenantId },
      data: { modelCategories: labelled.labels, modelCategoriesVersion: labelled.version, modelCategoriesAt: new Date() },
    })
    return stored.count > 0
  } catch (err) {
    // Never fails the read it follows: its callbacks still run, on the rules alone.
    if (err instanceof VlmUnavailableError) console.warn("[statement-analysis] model labels unavailable:", { analysisId: analysis.id })
    else console.error("[statement-analysis] model labels failed:", { analysisId: analysis.id, error: err instanceof Error ? err.name : "unknown" })
    return false
  }
}
