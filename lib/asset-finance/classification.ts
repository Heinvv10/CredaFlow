import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { classifyNcaRegime, type NcaClassification } from "./nca-classifier"

// Runs the NCA classifier for an entity application and snapshots the result
// on it (DESIGN D5). Every move to NON_NCA goes through four-eyes: a classifier
// result of NON_NCA leaves the application NCA (its effective regime until a
// second person agrees) and opens a PENDING NcaRegimeOverride NCA → NON_NCA in
// the classifier's name, which a different user with decide_asset_finance
// approves through the decide route. The database is the backstop:
// guardLoanApplicationNcaRegime refuses any change to NON_NCA that does not
// spend an approved override and freezes the regime and snapshot once the
// application is decided; LoanApplication_nca_classification_complete refuses
// a partial snapshot.

/** The transaction client of the app's (tenant-scoped) Prisma client. */
export type RegimeTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** Statuses in which an application's regime may still change (mirrors the trigger). */
export const NCA_REGIME_OPEN_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const

/** The note on an approval refused because the application's regime moved since the request. */
export const STALE_OVERRIDE_NOTE = "stale: regime changed"

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
}

type Regime = "NCA" | "NON_NCA"

export type ClassifyApplicationResult =
  | {
      kind: "classified"
      classification: NcaClassification
      previousRegime: Regime | null
      /** The application's regime after this call; NCA while a move to NON_NCA awaits approval. */
      regime: Regime
      /** The PENDING NCA → NON_NCA override awaiting a second approver, if any. */
      pendingOverrideId: string | null
    }
  | { kind: "not_found" }
  | { kind: "not_entity_borrower" }
  | { kind: "regime_frozen"; status: string }

/** The override reason recorded for a classifier result of NON_NCA. */
export function classifierOverrideReason(classification: NcaClassification): string {
  return `Classifier: ${classification.rule} — ${classification.reason}`
}

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

  // NON_NCA is never written here. An application already NON_NCA (approved
  // earlier) stays so when the classifier agrees; otherwise the effective
  // regime is NCA, and a NON_NCA result becomes a request for a second person.
  const regime: Regime =
    classification.regime === "NON_NCA" && application.ncaRegime === "NON_NCA" ? "NON_NCA" : "NCA"
  await tx.loanApplication.update({
    where: { id: application.id, tenantId },
    data: {
      ncaRegime: regime,
      ncaClassificationRule: classification.rule,
      ncaClassificationInputs: { ...classification.inputs },
      ncaClassificationEvidenceIds: classification.evidenceIds,
      ncaClassifiedAt: new Date(),
      ncaClassifiedById: params.userId,
    },
  })

  let pendingOverrideId: string | null = null
  if (classification.regime === "NON_NCA" && regime === "NCA") {
    pendingOverrideId = await requestNonNcaOverride(tx, params, classification)
  }

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
        ncaRegime: regime,
        classifierRegime: classification.regime,
        rule: classification.rule,
        evidenceIds: classification.evidenceIds,
        principalDebtCents: classification.inputs.principalDebtCents,
        pendingOverrideId,
      },
    },
    tx,
  )
  return { kind: "classified", classification, previousRegime: application.ncaRegime, regime, pendingOverrideId }
}

/**
 * The PENDING NCA → NON_NCA override for a classifier result: the open one if
 * the application already has one (at most one, index
 * NcaRegimeOverride_one_pending_per_application), else a new one in the
 * classifying user's name. Every PENDING override is NCA → NON_NCA: a move to
 * NCA is decided when it is requested.
 */
async function requestNonNcaOverride(
  tx: RegimeTx,
  params: ClassifyApplicationParams,
  classification: NcaClassification,
): Promise<string> {
  const { tenantId, applicationId } = params
  const open = await tx.ncaRegimeOverride.findFirst({
    where: { tenantId, applicationId, status: "PENDING" },
    select: { id: true },
  })
  if (open) return open.id

  const reason = classifierOverrideReason(classification)
  const override = await tx.ncaRegimeOverride.create({
    data: { tenantId, applicationId, fromRegime: "NCA", toRegime: "NON_NCA", reason, requestedById: params.userId },
    select: { id: true },
  })
  await logAuditStrict(
    {
      tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: AuditAction.NCA_OVERRIDE_REQUESTED,
      entity: "NcaRegimeOverride",
      entityId: override.id,
      newValue: { applicationId, fromRegime: "NCA", toRegime: "NON_NCA", reason, status: "PENDING", byClassifier: true },
    },
    tx,
  )
  return override.id
}
