/**
 * The consumer bureau check for each director and trustee of a deal's entity
 * (goal decision 2a.3: no commercial bureau API in slice 1).
 *
 * WHY NOT runBureauReviewCheck. The consumer path (lib/compliance/
 * bureau-review.ts) only stores a result while the application is
 * UNDER_REVIEW for that same client in the current bureauReviewGeneration:
 * an entity application has no clientId, so every director's result would
 * be discarded as "stale". This module makes the SAME provider call
 * (getCreditReport(buildExperianEnquiryInput(...)), the live Experian path),
 * applies the SAME POPIA consent rule, and stores the same rows: a
 * CreditBureauCheck for a result and a CREDIT_BUREAU_CHECK ComplianceRecord
 * for every attempt, both keyed to the deal's application. Keep the consent
 * rule identical to bureau-review.ts.
 *
 * A JURISTIC trustee (a company acting as trustee) is not a natural person
 * and gets no consumer check; it is listed as skipped.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { getCreditReport } from "@/lib/integrations/experian"
import { buildExperianEnquiryInput } from "@/lib/integrations/experian-input"

/** "recent": a check stored for this application within RECHECK_WINDOW_DAYS; no enquiry was made. */
export type DealBureauOutcome = "stored" | "skipped" | "failed" | "recent"

/** A person checked for this application this recently is not checked again unless the run is forced. */
export const RECHECK_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface DealBureauSubject {
  clientId: string
  role: "DIRECTOR" | "TRUSTEE"
  trusteeKind: "NATURAL" | "JURISTIC" | null
}

const PROVIDER = "experian"
// The enquiry runs inside the transaction that holds the per-person lock:
// long enough for the provider's own timeout (EXPERIAN_TIMEOUT_MS, 20 s) and
// for a concurrent request's enquiry to finish first.
const ENQUIRY_TRANSACTION_MS = 60_000

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type BureauDb = Pick<Tx, "client" | "complianceRecord" | "creditBureauCheck">

async function recordAttempt(
  db: BureauDb,
  tenantId: string,
  applicationId: string,
  status: "ACKNOWLEDGED" | "PENDING",
  data: Prisma.InputJsonObject,
): Promise<void> {
  await db.complianceRecord.create({
    data: {
      tenantId,
      type: "CREDIT_BUREAU_CHECK",
      status,
      referenceId: applicationId,
      completedAt: status === "ACKNOWLEDGED" ? new Date() : null,
      data: { provider: PROVIDER, assetFinance: true, ...data },
    },
  })
}

/** The active DIRECTOR and TRUSTEE relationships of the entity, one per person and role. */
export async function dealBureauSubjects(tenantId: string, entityId: string): Promise<DealBureauSubject[]> {
  const rows = await prisma.entityRelationship.findMany({
    where: { tenantId, entityId, active: true, role: { in: ["DIRECTOR", "TRUSTEE"] } },
    orderBy: { createdAt: "asc" },
    select: { clientId: true, role: true, trusteeKind: true },
  })
  return rows.map((r) => ({ clientId: r.clientId, role: r.role as DealBureauSubject["role"], trusteeKind: r.trusteeKind }))
}

/**
 * Of `clientIds`, those with a successful check stored for this application
 * within the last RECHECK_WINDOW_DAYS. Each consumer enquiry leaves a footprint
 * on the person's credit record, so a re-run inside the window needs `force`.
 */
export async function recentlyCheckedClientIds(
  tenantId: string,
  applicationId: string,
  clientIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set()
  const rows = await prisma.creditBureauCheck.findMany({
    where: {
      tenantId, applicationId, clientId: { in: clientIds }, ok: true,
      createdAt: { gte: new Date(now.getTime() - RECHECK_WINDOW_DAYS * DAY_MS) },
    },
    select: { clientId: true },
  })
  return new Set(rows.map((r) => r.clientId))
}

/**
 * One person's check for this application. Concurrent requests for the same
 * (application, person) queue on a transaction-scoped advisory lock held
 * across the stored-check lookup, the enquiry and its rows, so two requests
 * make one enquiry: the second sees the first's stored check and answers
 * "recent". Without `force` a check stored in the last RECHECK_WINDOW_DAYS is
 * recent; with it, only one stored since this request started (`startedAt`,
 * i.e. by a concurrent request).
 */
export async function runDealBureauCheck(
  tenantId: string,
  applicationId: string,
  subject: DealBureauSubject,
  opts: { force: boolean; startedAt: Date },
): Promise<DealBureauOutcome> {
  const { clientId } = subject
  if (subject.trusteeKind === "JURISTIC") {
    await recordAttempt(prisma, tenantId, applicationId, "ACKNOWLEDGED", { clientId, outcome: "skipped", reason: "JURISTIC_TRUSTEE" })
    return "skipped"
  }
  const since = opts.force ? opts.startedAt : new Date(opts.startedAt.getTime() - RECHECK_WINDOW_DAYS * DAY_MS)
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`deal-bureau:${tenantId}:${applicationId}:${clientId}`}, 0))`)
    const stored = await tx.creditBureauCheck.count({
      where: { tenantId, applicationId, clientId, ok: true, createdAt: { gte: since } },
    })
    return stored > 0 ? "recent" : enquire(tx, tenantId, applicationId, clientId)
  }, { timeout: ENQUIRY_TRANSACTION_MS })
}

/**
 * The enquiry and its rows, in the caller's transaction. A lookup or provider
 * failure is recorded as a failed attempt; a failure to store the result
 * rolls the transaction back and propagates.
 */
async function enquire(db: BureauDb, tenantId: string, applicationId: string, clientId: string): Promise<DealBureauOutcome> {
  const client = await db.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      idNumber: true,
      firstName: true,
      lastName: true,
      gender: true,
      dateOfBirth: true,
      popiaConsentGiven: true,
      consent: { select: { creditBureauEnquiry: true, withdrawnAt: true } },
    },
  })
  if (!client) {
    await recordAttempt(db, tenantId, applicationId, "PENDING", { clientId, outcome: "failed", error: "client not found" })
    return "failed"
  }
  // POPIA gate, as lib/compliance/bureau-review.ts: granular consent is
  // authoritative when it exists; the umbrella flag is the legacy fallback.
  const granular = client.consent
  const consentGranted = granular ? granular.creditBureauEnquiry && granular.withdrawnAt === null : client.popiaConsentGiven
  if (!consentGranted) {
    const reason = granular ? (granular.withdrawnAt ? "CONSENT_WITHDRAWN" : "CONSENT_REFUSED") : "CONSENT_MISSING"
    await recordAttempt(db, tenantId, applicationId, "ACKNOWLEDGED", { clientId, outcome: "skipped", skipped: true, reason })
    return "skipped"
  }

  const identity = {
    idNumber: client.idNumber,
    firstName: client.firstName,
    lastName: client.lastName,
    gender: client.gender,
    dateOfBirth: client.dateOfBirth,
  }
  let result: Awaited<ReturnType<typeof getCreditReport>>
  try {
    result = await getCreditReport(
      buildExperianEnquiryInput({
        ...identity,
        gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null,
        consentGranted: true,
        applicationId,
      }),
    )
  } catch (error) {
    await recordAttempt(db, tenantId, applicationId, "PENDING", {
      clientId,
      outcome: "failed",
      error: error instanceof Error ? error.message : "bureau check failed",
    })
    return "failed"
  }
  await db.creditBureauCheck.create({
    data: {
      tenantId,
      clientId,
      applicationId,
      subjectFingerprint: bureauSubjectFingerprint({ id: clientId, ...identity }),
      provider: PROVIDER,
      score: result.score ?? null,
      riskGrade: result.riskGrade ?? null,
      adverseInfo: result.adverseInfo ?? [],
      hasAdverse: (result.adverseInfo?.length ?? 0) > 0,
      deceased: result.deceased ?? false,
      underDebtReview: result.underDebtReview ?? false,
      hasJudgement: result.hasJudgement ?? false,
      hasNotice: result.hasNotice ?? false,
      unscoreable: result.unscoreable ?? false,
      declineReasons: result.declineReasons ?? [],
      ok: result.ok,
      errorMessage: result.error ?? null,
    },
  })
  await db.complianceRecord.create({
    data: {
      tenantId,
      type: "CREDIT_BUREAU_CHECK",
      status: result.ok ? "COMPLETED" : "PENDING",
      referenceId: applicationId,
      completedAt: result.ok ? new Date() : null,
      data: {
        provider: PROVIDER,
        assetFinance: true,
        clientId,
        // This attempt's result is the CreditBureauCheck row above.
        withCheck: true,
        outcome: result.ok ? "stored" : "failed",
        score: result.score ?? null,
        riskGrade: result.riskGrade ?? null,
        error: result.error ?? null,
      },
    },
  })
  return result.ok ? "stored" : "failed"
}
