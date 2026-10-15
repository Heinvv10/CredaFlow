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
  try {
    // The client's name and the statement's holder name: a transfer to either
    // is an own transfer by the rules (as on read) and never sent to the model.
    const doc = await prisma.clientDocument.findFirst({
      where: { id: analysis.clientDocumentId, tenantId },
      select: { client: { select: { firstName: true, lastName: true } } },
    })
    const names = [analysis.accountHolderName, doc?.client ? `${doc.client.firstName} ${doc.client.lastName}` : null]
    const keys = (analysis.transactions as unknown as StatementTransaction[])
      .filter((t) => t.amountCents < 0 && !t.nonPosting && names.every((clientName) => categorise(t, { clientName }).category === "UNCATEGORISED"))
      .map((t) => labelKey(t.description))
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
