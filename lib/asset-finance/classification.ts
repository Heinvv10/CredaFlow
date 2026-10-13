import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { classifyNcaRegime, type NcaClassification } from "./nca-classifier"

// Runs the NCA classifier for an entity application and snapshots the result
// on it (DESIGN D5). The database is the backstop: guardLoanApplicationNcaRegime
// refuses NCA → NON_NCA without an approved override and freezes the regime
// once the application is decided; LoanApplication_nca_classification_complete
// refuses a partial snapshot.

/** The transaction client of the app's (tenant-scoped) Prisma client. */
export type RegimeTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Statuses in which an application's regime may still change (mirrors the trigger). */
export const NCA_REGIME_OPEN_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const

export function isRegimeOpen(status: string): boolean {
  return (NCA_REGIME_OPEN_STATUSES as readonly string[]).includes(status)
}

/**
 * Lock the application row for the rest of the transaction. Classification,
 * override requests and override decisions all take this lock first, so they
 * serialise per application and always lock in the same order.
 */
export async function lockApplicationForRegime(
  tx: RegimeTx,
  tenantId: string,
  applicationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "LoanApplication"
    WHERE "id" = ${applicationId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)
  return rows.length > 0
}

export interface ClassifyApplicationParams {
  tenantId: string
  applicationId: string
  userId: string
  userEmail?: string
  /** Defaults to the application's appliedAmount (cents). */
  principalDebtCents?: number
  /**
   * Letters of Authority document ids for a trust. There is no entity
   * document store yet (goal §4.5), so the caller supplies them.
   * PARTIAL: the ids are recorded as given; nothing yet checks that they name
   * real documents belonging to this entity.
   */
  trusteeEvidenceIds?: string[]
  /**
   * The caller holds credit authority (`decide_asset_finance`). A NON_NCA
   * result switches off the consumer protections, so only such a user may
   * record one; anyone else gets `needs_credit_authority` and nothing is written.
   */
  mayClassifyNonNca: boolean
}

export type ClassifyApplicationResult =
  | { kind: "classified"; classification: NcaClassification; previousRegime: "NCA" | "NON_NCA" | null }
  | { kind: "not_found" }
  | { kind: "not_entity_borrower" }
  | { kind: "regime_frozen"; status: string }
  | { kind: "needs_override"; classification: NcaClassification }
  | { kind: "needs_credit_authority"; classification: NcaClassification }

export async function classifyApplication(
  tx: RegimeTx,
  params: ClassifyApplicationParams,
): Promise<ClassifyApplicationResult> {
  const { tenantId, applicationId } = params
  if (!(await lockApplicationForRegime(tx, tenantId, applicationId))) return { kind: "not_found" }

  const application = await tx.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: {
      id: true,
      entityId: true,
      status: true,
      appliedAmount: true,
      ncaRegime: true,
      ncaClassificationRule: true,
    },
  })
  if (!application) return { kind: "not_found" }
  // A natural person is always an NCA consumer; there is nothing to classify.
  if (!application.entityId) return { kind: "not_entity_borrower" }
  if (!isRegimeOpen(application.status)) return { kind: "regime_frozen", status: application.status }

  const entity = await tx.businessEntity.findFirst({
    where: { id: application.entityId, tenantId },
    select: {
      type: true,
      annualTurnover: true,
      totalAssetValue: true,
      financialsEvidenceIds: true,
      relationships: {
        where: { tenantId, role: "TRUSTEE", active: true },
        select: { trusteeKind: true },
      },
    },
  })
  // The composite FK binds the entity to the application's tenant.
  if (!entity) return { kind: "not_found" }

  const classification = classifyNcaRegime({
    entityType: entity.type,
    // CHECK EntityRelationship_trustee_kind: every TRUSTEE row has a kind.
    trustees: entity.relationships.flatMap((r) => (r.trusteeKind ? [{ kind: r.trusteeKind }] : [])),
    annualTurnoverCents: entity.annualTurnover,
    totalAssetValueCents: entity.totalAssetValue,
    financialsEvidenceIds: entity.financialsEvidenceIds,
    // PARTIAL: slice 1 has no separate "staff verified these figures" flag, so
    // figures with at least one evidence document count as verified. Replace
    // with an explicit verification (who, when) once entity documents land.
    financialsVerified:
      entity.financialsEvidenceIds.length > 0 &&
      (entity.annualTurnover !== null || entity.totalAssetValue !== null),
    trusteeEvidenceIds: params.trusteeEvidenceIds ?? [],
    principalDebtCents: params.principalDebtCents ?? application.appliedAmount,
  })

  // Relaxing the regime is an override decision, never a re-classification.
  // The trigger would refuse this write; answer before attempting it.
  if (application.ncaRegime === "NCA" && classification.regime === "NON_NCA") {
    return { kind: "needs_override", classification }
  }
  if (classification.regime === "NON_NCA" && !params.mayClassifyNonNca) {
    return { kind: "needs_credit_authority", classification }
  }

  await tx.loanApplication.update({
    where: { id: application.id, tenantId },
    data: {
      ncaRegime: classification.regime,
      ncaClassificationRule: classification.rule,
      ncaClassificationInputs: { ...classification.inputs },
      ncaClassificationEvidenceIds: classification.evidenceIds,
      ncaClassifiedAt: new Date(),
      ncaClassifiedById: params.userId,
    },
  })
  await logAuditStrict(
    {
      tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: AuditAction.NCA_CLASSIFIED,
      entity: "LoanApplication",
      entityId: application.id,
      oldValue: { ncaRegime: application.ncaRegime, rule: application.ncaClassificationRule },
      newValue: {
        ncaRegime: classification.regime,
        rule: classification.rule,
        evidenceIds: classification.evidenceIds,
        principalDebtCents: classification.inputs.principalDebtCents,
      },
    },
    tx,
  )
  return { kind: "classified", classification, previousRegime: application.ncaRegime }
}
