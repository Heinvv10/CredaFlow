import type { RecoveryRoute } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate } from "./dates"
import type { SigningTx } from "./signing-prepare"

export interface RecoveryActor { tenantId: string; userId: string; userEmail?: string | null }

export interface CreateRecoveryInput {
  loanId: string
  route: RecoveryRoute
  recoveredOn: string // YYYY-MM-DD (SAST)
  location: string
  condition: string
  surrenderRequestId?: string | null
  legalMatterId?: string | null
  meterReadingId?: string | null
}

/** The database's own sentences (guardRecovery): a recovery is opened by the loan that holds the asset now. */
export const RECOVERY_LOAN_STATUS = "A recovery is opened on an active, defaulted or pending write-off loan"
export const RECOVERY_HOLDER_ONLY = "A recovery is opened by the loan that holds the asset now"

export type CreateRecoveryResult = { kind: "not_found" } | { kind: "not_ready"; reason: string } | { kind: "done"; id: string }

/**
 * The single place a Recovery row is created (staff create, surrender link,
 * legal-matter ASSET_RECOVERED step). Runs inside the caller's transaction;
 * the database (guardRecovery, syncRecoveryAssetStatus) enforces the route,
 * regime, one-open-per-loan and asset-status rules.
 */
export async function createRecoveryTx(tx: SigningTx, actor: RecoveryActor, input: CreateRecoveryInput): Promise<CreateRecoveryResult> {
  const location = input.location.trim()
  const condition = input.condition.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recoveredOn)) return { kind: "not_ready", reason: "Provide the recovery date as YYYY-MM-DD" }
  if (location.length < 2 || location.length > 500) return { kind: "not_ready", reason: "Describe the yard or location in 2 to 500 characters" }
  if (condition.length < 3 || condition.length > 2_000) return { kind: "not_ready", reason: "Describe the asset condition in 3 to 2000 characters" }
  const loan = await tx.loan.findFirst({ where: { id: input.loanId, tenantId: actor.tenantId }, select: { id: true, assetId: true, status: true } })
  if (!loan?.assetId) return { kind: "not_found" }
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED" && loan.status !== "PENDING_WRITE_OFF") return { kind: "not_ready", reason: RECOVERY_LOAN_STATUS }
  // an asset that was re-leased belongs to its live loan, not to the earlier one that ended
  const otherLive = await tx.loan.count({ where: { tenantId: actor.tenantId, assetId: loan.assetId, id: { not: loan.id }, status: { notIn: ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] } } })
  if (otherLive > 0) return { kind: "not_ready", reason: RECOVERY_HOLDER_ONLY }
  const created = await tx.recovery.create({ data: {
    tenantId: actor.tenantId, loanId: loan.id, assetId: loan.assetId, route: input.route,
    surrenderRequestId: input.surrenderRequestId ?? null, legalMatterId: input.legalMatterId ?? null,
    meterReadingId: input.meterReadingId ?? null, recoveredOn: dbDate(input.recoveredOn),
    location, condition, createdById: actor.userId,
  } })
  await logAuditStrict({
    tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
    action: AuditAction.ASSET_RECOVERY_CREATED, entity: "Recovery", entityId: created.id,
    newValue: { loanId: loan.id, assetId: loan.assetId, route: input.route, recoveredOn: input.recoveredOn,
      surrenderRequestId: input.surrenderRequestId ?? null, legalMatterId: input.legalMatterId ?? null },
  }, tx)
  return { kind: "done", id: created.id }
}
