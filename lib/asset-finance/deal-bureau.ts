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
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { bureauSubjectFingerprint } from "@/lib/compliance/bureau-subject"
import { getCreditReport } from "@/lib/integrations/experian"
import { buildExperianEnquiryInput } from "@/lib/integrations/experian-input"

export type DealBureauOutcome = "stored" | "skipped" | "failed"

export interface DealBureauSubject {
  clientId: string
  role: "DIRECTOR" | "TRUSTEE"
  trusteeKind: "NATURAL" | "JURISTIC" | null
}

const PROVIDER = "experian"

async function recordAttempt(
  tenantId: string,
  applicationId: string,
  status: "ACKNOWLEDGED" | "PENDING",
  data: Prisma.InputJsonObject,
): Promise<void> {
  await prisma.complianceRecord.create({
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

export async function runDealBureauCheck(
  tenantId: string,
  applicationId: string,
  subject: DealBureauSubject,
): Promise<DealBureauOutcome> {
  const { clientId } = subject
  if (subject.trusteeKind === "JURISTIC") {
    await recordAttempt(tenantId, applicationId, "ACKNOWLEDGED", { clientId, outcome: "skipped", reason: "JURISTIC_TRUSTEE" })
    return "skipped"
  }
  try {
    const client = await prisma.client.findFirst({
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
      await recordAttempt(tenantId, applicationId, "PENDING", { clientId, outcome: "failed", error: "client not found" })
      return "failed"
    }
    // POPIA gate, as lib/compliance/bureau-review.ts: granular consent is
    // authoritative when it exists; the umbrella flag is the legacy fallback.
    const granular = client.consent
    const consentGranted = granular ? granular.creditBureauEnquiry && granular.withdrawnAt === null : client.popiaConsentGiven
    if (!consentGranted) {
      const reason = granular ? (granular.withdrawnAt ? "CONSENT_WITHDRAWN" : "CONSENT_REFUSED") : "CONSENT_MISSING"
      await recordAttempt(tenantId, applicationId, "ACKNOWLEDGED", { clientId, outcome: "skipped", skipped: true, reason })
      return "skipped"
    }

    const identity = {
      idNumber: client.idNumber,
      firstName: client.firstName,
      lastName: client.lastName,
      gender: client.gender,
      dateOfBirth: client.dateOfBirth,
    }
    const result = await getCreditReport(
      buildExperianEnquiryInput({
        ...identity,
        gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null,
        consentGranted: true,
        applicationId,
      }),
    )
    await prisma.$transaction([
      prisma.creditBureauCheck.create({
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
      }),
      prisma.complianceRecord.create({
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
      }),
    ])
    return result.ok ? "stored" : "failed"
  } catch (error) {
    await recordAttempt(tenantId, applicationId, "PENDING", {
      clientId,
      outcome: "failed",
      error: error instanceof Error ? error.message : "bureau check failed",
    })
    return "failed"
  }
}
