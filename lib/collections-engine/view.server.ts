/**
 * Read models for the staff UI: the loan page's mandate panel and the batch
 * list. Both return null while the tenant's engine is off, and the UI then
 * renders nothing, so a lender without the engine sees the pages unchanged.
 */
import type { CollectionBatch, CollectionInstruction, CollectionResult, DebitMandate } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { loadApplicationFacts } from "@/lib/credit-checks/load-facts"
import { recommendStrikeDate, type StrikeDateRecommendation } from "./strike-date"
import { LIVE_MANDATE_STATUSES } from "./state-machine"

export type MandateWithHistory = DebitMandate & {
  instructions: Array<CollectionInstruction & { results: CollectionResult[] }>
}

export interface LoanCollectionsView {
  provider: string | null
  mandates: MandateWithHistory[]
  liveMandate: MandateWithHistory | null
  canCreate: boolean
  recommendation: StrikeDateRecommendation | null
  /** Why no recommendation could be computed, when that was an error rather than missing evidence. */
  recommendationError: string | null
}

async function engineConfig(tenantId: string) {
  return prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { collectionsEngineEnabled: true, collectionProvider: true },
  })
}

async function strikeDate(tenantId: string, applicationId: string, declaredPayDay: number | null) {
  const loaded = await loadApplicationFacts(tenantId, applicationId, { persistedOnly: true })
  const facts = loaded?.facts
  const slip = facts?.payslip
  return recommendStrikeDate({
    statements: (facts?.statements ?? []).flatMap((s) => (s.state === "READ" && s.read ? [{ transactions: s.read.transactions }] : [])),
    netPayCents: slip && slip.validated && slip.matchesClient ? slip.netPayCents : null,
    declaredPayDay,
  })
}

export async function loadLoanCollectionsView(tenantId: string, loan: {
  id: string
  applicationId: string
  status: string
  clientId: string | null
  client: { salaryPaymentDay: number | null } | null
}): Promise<LoanCollectionsView | null> {
  const config = await engineConfig(tenantId)
  if (!config?.collectionsEngineEnabled) return null

  const mandates = await prisma.debitMandate.findMany({
    where: { tenantId, loanId: loan.id },
    include: { instructions: { include: { results: { orderBy: { resolvedAt: "asc" } } }, orderBy: [{ actionDate: "desc" }, { presentmentNo: "desc" }] } },
    orderBy: { createdAt: "desc" },
  })
  const liveMandate = mandates.find((m) => LIVE_MANDATE_STATUSES.includes(m.status)) ?? null
  const collectible = loan.status === "ACTIVE" || loan.status === "DEFAULTED"

  let recommendation: StrikeDateRecommendation | null = null
  let recommendationError: string | null = null
  if (!liveMandate && collectible && loan.clientId) {
    try {
      recommendation = await strikeDate(tenantId, loan.applicationId, loan.client?.salaryPaymentDay ?? null)
    } catch (error) {
      // Advice only: a failed read must not take the loan page down with it.
      recommendationError = error instanceof Error ? error.message : "Statement evidence could not be read"
    }
  }

  return {
    provider: config.collectionProvider,
    mandates,
    liveMandate,
    canCreate: !liveMandate && collectible && Boolean(loan.clientId) && Boolean(config.collectionProvider),
    recommendation,
    recommendationError,
  }
}

export type BatchListRow = CollectionBatch

/** The latest batches, newest first; null while the engine is off. */
export async function loadBatchList(tenantId: string, take = 100): Promise<BatchListRow[] | null> {
  const config = await engineConfig(tenantId)
  if (!config?.collectionsEngineEnabled) return null
  return prisma.collectionBatch.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take })
}
