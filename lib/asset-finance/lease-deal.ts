/**
 * What a lease deal stores beside an instalment sale's columns (slice 3, C1):
 * its lease terms and its Consumer Protection Act scope, and the NON_NCA
 * classification its application is written with. Shared by deal creation
 * and submission (the CPA scope is re-run at submit, then frozen at approval
 * by freezeApprovedLeaseTerms).
 */
import { Prisma } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { classifyCpaScope, type CpaScope } from "./cpa-scope"
import { nullableFigureFromDb } from "./big-cents"
import type { LeaseTerms } from "./lease-input"

/**
 * The NON_NCA classification a lease application is written with. An
 * operating or full-maintenance lease is not a credit agreement: ownership
 * never passes, so the NCA definition of a lease is not met.
 * // UNTESTED: legal — the lender's legal team to confirm.
 */
export function leaseApplicationRegime(userId: string, contractType: string) {
  return {
    ncaRegime: "NON_NCA" as const,
    ncaClassificationRule: "LEASE_NOT_CREDIT_AGREEMENT",
    ncaClassificationInputs: { contractType },
    ncaClassifiedAt: new Date(),
    ncaClassifiedById: userId,
  }
}

/** The lessee's CPA scope: a sole proprietor is a natural person; an entity on its evidenced financials. */
export async function leaseCpaScope(
  tx: RegimeTx,
  tenantId: string,
  lessee: { clientId: string | null; entityId: string | null },
): Promise<CpaScope | null> {
  if (lessee.clientId !== null) return classifyCpaScope({ lessee: "NATURAL_PERSON" })
  if (lessee.entityId === null) return null
  const entity = await tx.businessEntity.findFirst({
    where: { id: lessee.entityId, tenantId },
    select: { type: true, annualTurnover: true, totalAssetValue: true, financialsEvidenceIds: true },
  })
  if (!entity) return null
  return classifyCpaScope({
    lessee: "JURISTIC",
    entityType: entity.type,
    annualTurnoverCents: nullableFigureFromDb(entity.annualTurnover),
    totalAssetValueCents: nullableFigureFromDb(entity.totalAssetValue),
    financialsEvidenceIds: entity.financialsEvidenceIds,
    // PARTIAL: as the NCA classifier (./classification.ts), figures with at
    // least one evidence document count as verified until entity documents
    // carry an explicit verification.
    financialsVerified: entity.financialsEvidenceIds.length > 0 && (entity.annualTurnover !== null || entity.totalAssetValue !== null),
  })
}

export function cpaColumns(scope: CpaScope) {
  return { cpaApplies: scope.applies, cpaRule: scope.rule, cpaEvidenceIds: scope.evidenceIds }
}

/** The deal's lease columns (AssetFinanceDeal_lease_terms_shape). */
export function leaseDealColumns(lease: LeaseTerms) {
  const { maintenance, usage } = lease
  return {
    rentalTiming: lease.rentalTiming,
    escalationRate: new Prisma.Decimal(lease.escalationRate),
    earlyTerminationPenaltyRate: new Prisma.Decimal(lease.earlyTerminationPenaltyRate),
    maintenanceMonthlyExclVatCents: maintenance?.monthlyExclVatCents ?? null,
    maintenanceEscalationRate: maintenance ? new Prisma.Decimal(maintenance.escalationRate) : null,
    maintenanceRiskModel: maintenance?.riskModel ?? null,
    usageAllowancePerYear: usage?.allowancePerYear ?? null,
    usageUnit: usage?.unit ?? null,
    excessRateCents: usage?.excessRateCents ?? null,
  }
}
