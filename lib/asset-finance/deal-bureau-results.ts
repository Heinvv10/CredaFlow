// The director/trustee bureau results of a deal (./deal-bureau.ts), newest
// first: every CreditBureauCheck on the deal's application, plus the attempts
// that produced none (consent missing, a juristic trustee, an error), which
// exist only as CREDIT_BUREAU_CHECK ComplianceRecords.
import { prisma } from "@/lib/prisma"
import { bureauCheckMatchesSubject, type BureauSubjectClient } from "@/lib/compliance/bureau-subject"

export interface DealBureauResult {
  clientId: string
  name: string
  outcome: "stored" | "skipped" | "failed" | "stale"
  provider: string
  score: number | null
  riskGrade: string | null
  hasAdverse: boolean
  deceased: boolean
  underDebtReview: boolean
  hasJudgement: boolean
  detail: string | null
  at: string
}

/** An attempt that left no CreditBureauCheck row; null for anything else. */
function attemptWithoutCheck(value: unknown): { clientId: string; outcome: string; provider?: string; reason?: string; error?: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (typeof data.clientId !== "string" || typeof data.outcome !== "string" || data.withCheck === true) return null
  return {
    clientId: data.clientId,
    outcome: data.outcome,
    provider: typeof data.provider === "string" ? data.provider : undefined,
    reason: typeof data.reason === "string" ? data.reason : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
  }
}

/** The models read: the app client, or a transaction (the decision re-reads them under its lock). */
export type BureauResultsDb = Pick<typeof prisma, "creditBureauCheck" | "complianceRecord" | "client">

export async function loadDealBureauResults(tenantId: string, applicationId: string, db: BureauResultsDb = prisma): Promise<DealBureauResult[]> {
  const [checks, attempts] = await Promise.all([
    db.creditBureauCheck.findMany({
      where: { tenantId, applicationId },
      orderBy: { createdAt: "desc" },
      select: {
        clientId: true, subjectFingerprint: true, provider: true, score: true, riskGrade: true, hasAdverse: true, deceased: true,
        underDebtReview: true, hasJudgement: true, ok: true, errorMessage: true, createdAt: true,
        client: { select: { id: true, idNumber: true, firstName: true, lastName: true, gender: true, dateOfBirth: true } },
      },
    }),
    db.complianceRecord.findMany({
      where: { tenantId, type: "CREDIT_BUREAU_CHECK", referenceId: applicationId },
      orderBy: { createdAt: "desc" },
      select: { data: true, createdAt: true },
    }),
  ])

  const results: DealBureauResult[] = checks.map((c) => ({
    clientId: c.clientId,
    name: `${c.client.firstName} ${c.client.lastName}`,
    outcome: c.ok ? bureauResultOutcome(c, c.client) : "failed",
    provider: c.provider,
    score: c.score,
    riskGrade: c.riskGrade,
    hasAdverse: c.hasAdverse,
    deceased: c.deceased,
    underDebtReview: c.underDebtReview,
    hasJudgement: c.hasJudgement,
    detail: c.ok && !bureauCheckMatchesSubject(c, c.client)
      ? "The person's identity changed after this enquiry; run a new bureau check"
      : c.errorMessage,
    at: c.createdAt.toISOString(),
  }))

  const without = attempts
    .map((a) => ({ data: attemptWithoutCheck(a.data), at: a.createdAt }))
    .filter((a) => a.data !== null)
  if (without.length > 0) {
    const ids = [...new Set(without.map((a) => a.data?.clientId ?? ""))]
    const clients = await db.client.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, firstName: true, lastName: true },
    })
    const names = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`]))
    for (const { data, at } of without) {
      if (!data) continue
      results.push({
        clientId: data.clientId,
        name: names.get(data.clientId) ?? data.clientId,
        outcome: data.outcome === "skipped" ? "skipped" : "failed",
        provider: data.provider ?? "experian",
        score: null, riskGrade: null, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false,
        detail: data.reason ?? data.error ?? null,
        at: at.toISOString(),
      })
    }
  }
  return results.sort((a, b) => b.at.localeCompare(a.at))
}

export function bureauResultOutcome(
  check: { clientId: string; subjectFingerprint: string | null },
  client: BureauSubjectClient,
): "stored" | "stale" {
  return bureauCheckMatchesSubject(check, client) ? "stored" : "stale"
}
