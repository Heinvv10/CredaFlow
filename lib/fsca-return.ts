/**
 * R-06 FSCA Quarterly Return — helpers.
 *
 * Quarter-math primitives and aggregate queries for the FSCA quarterly return.
 * All "quarter" strings are of the form "YYYY-Qn" where n ∈ [1..4].
 * Date ranges are end-exclusive UTC, suitable for direct use in Prisma
 * `gte` / `lt` filters.
 */

import { prisma } from "@/lib/prisma"
import { parseStatutoryNumber } from "@/lib/config/identity"
import type {
  ClaimStatus,
  ComplaintStatus,
  ComplaintOutcome,
  InsurancePolicyType,
} from "@prisma/client"

// Quarter math lives in one place for every statutory return — see
// `lib/compliance/quarters.ts` for why (this file previously computed
// UTC-midnight bounds while the Section 129 register computed SAST-midnight
// bounds, so the two disagreed about a two-hour window at every quarter edge).
// Re-exported rather than re-implemented so existing importers are unchanged.
export {
  QUARTER_RE,
  quarterBounds,
  listSelectableQuarters,
  defaultQuarter,
  parseQuarterParam,
} from "@/lib/compliance/quarters"

import { quarterBounds } from "@/lib/compliance/quarters"

export type ClaimBucket = { count: number; value: number }

export type FscaReturnData = {
  quarter: string
  fspNumber: string
  policiesInForce: { count: number; sumAssured: number }
  gwp: { count: number; total: number }
  newBusiness: {
    byType: Record<InsurancePolicyType, number>
    total: number
  }
  claims: Record<ClaimStatus, ClaimBucket>
  lapses: { count: number; sumAssured: number }
  complaints: {
    byStatus: Record<ComplaintStatus, number>
    byOutcome: Record<ComplaintOutcome, number>
    total: number
  }
  ppr: { issued: number; acknowledged: number; ratio: number | null }
  advisorCommissions: { total: number }
  submittedAt: Date | null
  submittedByName: string | null
}

const CLAIM_STATUSES: ClaimStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "PAID",
]

const POLICY_TYPES: InsurancePolicyType[] = [
  "FUNERAL_COVER",
  "CREDIT_LIFE",
  "LIFE_INSURANCE",
  "SHORT_TERM_MOTOR",
  "SHORT_TERM_HOME",
  "SHORT_TERM_CONTENTS",
  "BUSINESS_INSURANCE",
]

const COMPLAINT_STATUSES: ComplaintStatus[] = [
  "OPEN",
  "UNDER_INVESTIGATION",
  "RESOLVED",
  "ESCALATED",
  "ESCALATED_OMBUD",
  "CLOSED",
]

const COMPLAINT_OUTCOMES: ComplaintOutcome[] = [
  "UPHELD",
  "PARTIALLY_UPHELD",
  "NOT_UPHELD",
  "WITHDRAWN",
]

export async function getFscaReturnData(
  tenantId: string,
  quarter: string,
): Promise<FscaReturnData> {
  const { start, end } = quarterBounds(quarter)

  const [
    policiesInForce,
    gwp,
    newByType,
    claimsByStatus,
    lapses,
    complaintsByStatus,
    complaintsByOutcome,
    pprIssued,
    pprAck,
    commissionsAgg,
    submittedRecord,
  ] = await Promise.all([
    prisma.insurancePolicy.aggregate({
      where: { tenantId, status: "ACTIVE", startDate: { lt: end } },
      _count: true,
      _sum: { sumAssured: true },
    }),
    prisma.insurancePolicy.aggregate({
      where: { tenantId, startDate: { gte: start, lt: end } },
      _count: true,
      _sum: { premiumAmount: true },
    }),
    prisma.insurancePolicy.groupBy({
      by: ["type"],
      where: { tenantId, startDate: { gte: start, lt: end } },
      _count: true,
    }),
    prisma.insuranceClaim.groupBy({
      by: ["status"],
      where: { tenantId, submittedAt: { gte: start, lt: end } },
      _count: true,
      _sum: { claimAmount: true, approvedAmount: true },
    }),
    // `updatedAt` is used as a lapse-event proxy because the schema has no
    // dedicated `lapsedAt` column. If a LAPSED policy is later edited for an
    // unrelated reason, it can drift into a different quarter's report.
    prisma.insurancePolicy.aggregate({
      where: { tenantId, status: "LAPSED", updatedAt: { gte: start, lt: end } },
      _count: true,
      _sum: { sumAssured: true },
    }),
    prisma.complaint.groupBy({
      by: ["status"],
      where: { tenantId, createdAt: { gte: start, lt: end } },
      _count: true,
    }),
    prisma.complaint.groupBy({
      by: ["outcome"],
      where: {
        tenantId,
        createdAt: { gte: start, lt: end },
        outcome: { not: null },
      },
      _count: true,
    }),
    prisma.insurancePolicy.count({
      where: {
        tenantId,
        startDate: { gte: start, lt: end },
        pprIssuedAt: { not: null },
      },
    }),
    prisma.insurancePolicy.count({
      where: {
        tenantId,
        startDate: { gte: start, lt: end },
        pprAcknowledgedAt: { not: null },
      },
    }),
    prisma.insurancePolicy.aggregate({
      where: { tenantId, startDate: { gte: start, lt: end } },
      _sum: { commissionAmount: true },
    }),
    prisma.complianceRecord.findFirst({
      where: {
        tenantId,
        type: "FSCA_QUARTERLY_RETURN",
        status: "SUBMITTED",
        data: { path: ["quarter"], equals: quarter },
      },
      orderBy: { completedAt: "desc" },
    }),
  ])

  const claims: Record<ClaimStatus, ClaimBucket> = Object.fromEntries(
    CLAIM_STATUSES.map((s) => [s, { count: 0, value: 0 } as ClaimBucket]),
  ) as Record<ClaimStatus, ClaimBucket>
  for (const row of claimsByStatus) {
    // For APPROVED/PAID statuses the regulator-relevant value is the
    // approved payout; for everything else it is the originally-claimed
    // amount. A per-row COALESCE isn't possible via Prisma groupBy._sum,
    // so we choose the right column per status. Null sums (empty bucket
    // or all-null column) collapse to 0.
    const useApproved = row.status === "APPROVED" || row.status === "PAID"
    const claimValue = useApproved
      ? Number(row._sum.approvedAmount ?? 0)
      : Number(row._sum.claimAmount ?? 0)
    claims[row.status] = { count: row._count, value: claimValue }
  }

  const byType: Record<InsurancePolicyType, number> = Object.fromEntries(
    POLICY_TYPES.map((t) => [t, 0]),
  ) as Record<InsurancePolicyType, number>
  let newBusinessTotal = 0
  for (const row of newByType) {
    byType[row.type] = row._count
    newBusinessTotal += row._count
  }

  const complaintsByStatusMap: Record<ComplaintStatus, number> =
    Object.fromEntries(
      COMPLAINT_STATUSES.map((s) => [s, 0]),
    ) as Record<ComplaintStatus, number>
  for (const row of complaintsByStatus) {
    complaintsByStatusMap[row.status] = row._count
  }

  const complaintsByOutcomeMap: Record<ComplaintOutcome, number> =
    Object.fromEntries(
      COMPLAINT_OUTCOMES.map((o) => [o, 0]),
    ) as Record<ComplaintOutcome, number>
  for (const row of complaintsByOutcome) {
    if (row.outcome) complaintsByOutcomeMap[row.outcome] = row._count
  }
  const complaintsTotal = complaintsByStatus.reduce((s, r) => s + r._count, 0)

  const recordData = submittedRecord?.data
  const submittedByUserId =
    recordData &&
    typeof recordData === "object" &&
    !Array.isArray(recordData) &&
    "submittedByUserId" in recordData
      ? String((recordData as Record<string, unknown>).submittedByUserId)
      : null
  let submittedByName: string | null = null
  if (submittedByUserId) {
    const user = await prisma.user.findUnique({
      where: { id: submittedByUserId },
      select: { name: true, email: true },
    })
    submittedByName = user ? user.name ?? user.email : null
  }

  // Throws LenderIdentityError when unset or invalid: the return must carry
  // the tenant's own FSP licence number, never a default.
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { fscaNumber: true } })
  const fspNumber = parseStatutoryNumber("fscaNumber", config?.fscaNumber)

  return {
    quarter,
    fspNumber,
    policiesInForce: {
      count: policiesInForce._count,
      sumAssured: Number(policiesInForce._sum.sumAssured ?? 0),
    },
    gwp: {
      count: gwp._count,
      total: Number(gwp._sum.premiumAmount ?? 0),
    },
    newBusiness: { byType, total: newBusinessTotal },
    claims,
    lapses: {
      count: lapses._count,
      sumAssured: Number(lapses._sum.sumAssured ?? 0),
    },
    complaints: {
      byStatus: complaintsByStatusMap,
      byOutcome: complaintsByOutcomeMap,
      total: complaintsTotal,
    },
    ppr: {
      issued: pprIssued,
      acknowledged: pprAck,
      ratio: pprIssued > 0 ? pprAck / pprIssued : null,
    },
    advisorCommissions: {
      total: Number(commissionsAgg._sum.commissionAmount ?? 0),
    },
    submittedAt: submittedRecord?.completedAt ?? null,
    submittedByName,
  }
}

/**
 * Durable reservation key for an FSCA submission, mirroring the NCR return.
 * `ComplianceRecord.idempotencyKey` is `@unique`, so two concurrent
 * submissions for one quarter cannot both land. The constraint is global, so
 * the key carries the tenant.
 */
export function fscaSubmissionKey(tenantId: string, quarter: string): string {
  return `fsca-return:${tenantId}:${quarter}`
}

/**
 * The figures as filed, frozen into the submission record.
 *
 * Every count here is recomputed from live rows — policies lapse, claims get
 * settled, complaints change status — so without a snapshot the record cannot
 * answer "what did we file". Aggregates only: no policy numbers, no client
 * identifiers.
 */
export function fscaSubmissionSnapshot(data: FscaReturnData) {
  return {
    quarter: data.quarter,
    fspNumber: data.fspNumber,
    policiesInForce: data.policiesInForce,
    gwp: data.gwp,
    newBusiness: data.newBusiness,
    claims: data.claims,
    lapses: data.lapses,
    complaints: data.complaints,
    ppr: data.ppr,
    advisorCommissions: data.advisorCommissions,
  }
}
