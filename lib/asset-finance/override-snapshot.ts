// The application facts an NcaRegimeOverride records when it is requested
// (DESIGN D5). An approval to NON_NCA authorises the change for exactly these:
// guardLoanApplicationNcaRegime refuses to spend it once the application no
// longer matches, CHECK NcaRegimeOverride_non_nca_snapshot requires them for a
// move to NON_NCA, and guardNcaRegimeOverrideLifecycle refuses a snapshot that
// is not the application as it stands at insert.

export interface OverrideSnapshot {
  approvedEntityId: string | null
  approvedAppliedAmount: number | null
  approvedProductId: string | null
  approvedClassificationRule: string | null
}

/** The fields of a LoanApplication an override snapshot is taken from. */
export interface SnapshotSource {
  entityId: string | null
  appliedAmount: number
  productId: string
  ncaClassificationRule: string | null
}

/** The note on a PENDING override a re-classification replaced. */
export const SUPERSEDED_OVERRIDE_NOTE = "superseded by re-classification"

export function overrideSnapshotOf(application: SnapshotSource): OverrideSnapshot {
  return {
    approvedEntityId: application.entityId,
    approvedAppliedAmount: application.appliedAmount,
    approvedProductId: application.productId,
    approvedClassificationRule: application.ncaClassificationRule,
  }
}

/** True when the override was requested on the application exactly as it now stands. */
export function overrideMatchesApplication(override: OverrideSnapshot, application: SnapshotSource): boolean {
  const current = overrideSnapshotOf(application)
  return (
    override.approvedEntityId !== null &&
    override.approvedEntityId === current.approvedEntityId &&
    override.approvedAppliedAmount === current.approvedAppliedAmount &&
    override.approvedProductId === current.approvedProductId &&
    override.approvedClassificationRule === current.approvedClassificationRule
  )
}
