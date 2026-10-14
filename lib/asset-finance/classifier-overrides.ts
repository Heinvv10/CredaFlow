import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { ClassifyApplicationParams, RegimeTx } from "./classification"
import type { NcaClassification } from "./nca-classifier"
import { overrideSnapshotOf, SUPERSEDED_OVERRIDE_NOTE, type SnapshotSource } from "./override-snapshot"

// The classifier's side of NcaRegimeOverride (DESIGN D5): the PENDING request
// a NON_NCA result opens for a second person, and the rejection of a request
// a later classification replaced.

/** The override reason recorded for a classifier result of NON_NCA. */
export function classifierOverrideReason(classification: NcaClassification): string {
  return `Classifier: ${classification.rule} — ${classification.reason}`
}

/**
 * Bring the application's open override (at most one, index
 * NcaRegimeOverride_one_pending_per_application; every PENDING override is
 * NCA → NON_NCA) in line with the classification just recorded:
 *  - NCA: a classifier-opened request is rejected as superseded; a manual one
 *    stays for its decider (the decide route rejects it as stale once its
 *    snapshot no longer matches).
 *  - NON_NCA: any open request is rejected as superseded and a fresh request
 *    opened in the classifying user's name. Its snapshot names the run just
 *    recorded (ncaClassifiedAt), so no earlier request can match this one.
 */
export async function reconcileOpenOverride(
  tx: RegimeTx,
  params: ClassifyApplicationParams,
  classification: NcaClassification,
  classified: SnapshotSource,
): Promise<{ pendingOverrideId: string | null; supersededOverrideId: string | null }> {
  const { tenantId, applicationId } = params
  const open = await tx.ncaRegimeOverride.findFirst({
    where: { tenantId, applicationId, status: "PENDING" },
    select: { id: true, source: true },
  })

  if (classification.regime === "NCA") {
    if (!open || open.source !== "CLASSIFIER") return { pendingOverrideId: null, supersededOverrideId: null }
    await rejectSuperseded(tx, params, open.id)
    return { pendingOverrideId: null, supersededOverrideId: open.id }
  }

  if (open) await rejectSuperseded(tx, params, open.id)

  const reason = classifierOverrideReason(classification)
  const snapshot = overrideSnapshotOf(classified)
  const override = await tx.ncaRegimeOverride.create({
    data: {
      tenantId,
      applicationId,
      fromRegime: "NCA",
      toRegime: "NON_NCA",
      reason,
      source: "CLASSIFIER",
      requestedById: params.userId,
      ...snapshot,
    },
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
      newValue: {
        applicationId, fromRegime: "NCA", toRegime: "NON_NCA", reason, status: "PENDING", source: "CLASSIFIER", ...snapshot,
      },
    },
    tx,
  )
  return { pendingOverrideId: override.id, supersededOverrideId: open?.id ?? null }
}

/** Reject an open override the latest classification replaced, in the classifying user's name. */
async function rejectSuperseded(tx: RegimeTx, params: ClassifyApplicationParams, overrideId: string): Promise<void> {
  await tx.ncaRegimeOverride.update({
    where: { id: overrideId },
    data: { status: "REJECTED", decidedById: params.userId, decidedAt: new Date(), decisionNote: SUPERSEDED_OVERRIDE_NOTE },
  })
  await logAuditStrict(
    {
      tenantId: params.tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: AuditAction.NCA_OVERRIDE_DECIDED,
      entity: "NcaRegimeOverride",
      entityId: overrideId,
      oldValue: { status: "PENDING" },
      newValue: {
        applicationId: params.applicationId, status: "REJECTED", note: SUPERSEDED_OVERRIDE_NOTE, superseded: true,
      },
    },
    tx,
  )
}
