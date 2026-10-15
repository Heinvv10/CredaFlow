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
  const loan = await tx.loan.findFirst({ where: { id: input.loanId, tenantId: actor.tenantId }, select: { id: true, assetId: true } })
  if (!loan?.assetId) return { kind: "not_found" }
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
