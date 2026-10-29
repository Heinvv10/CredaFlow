/**
 * Audit log helper — records all key platform actions to AuditLog table
 */

import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { AUDIT_ACTIONS } from "@/lib/registry/generated/audit-actions"

interface AuditParams {
  /** Only for a caller that must know the row's id before it commits (lib/audit/siem/policy.ts). */
  id?: string
  tenantId?: string
  userId?: string
  userEmail?: string
  action: string
  entity: string
  entityId?: string
  oldValue?: Record<string, unknown> | null
  newValue?: Record<string, unknown> | null
  ipAddress?: string
}

export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await logAuditStrict(params)
  } catch (error) {
    // Audit log failures must never break the main operation — but they must
    // not be invisible either. Callers rely on this row as the ONLY record of
    // money-moving changes (e.g. a referral commission reassignment in
    // app/api/clients/[id]/route.ts), and a silent no-op means that record is
    // simply gone with nothing to alert on.
    console.error(
      "Failed to write audit log:",
      { action: params.action, entity: params.entity, entityId: params.entityId },
      error,
    )
  }
}

// Settlement evidence (lib/loan/settlement.ts settlementAuditEvidence) is
// written only by the receipt writers, straight to the table. Dropped here so
// an audit of a raw request body can never carry it; the database refuses it on
// any other action (AuditLog_settlement_evidence_receipts_only).
const SETTLEMENT_EVIDENCE_KEYS = ["earlyInstalmentSettlement", "earlyDailySettlement", "contractualRows"]

function withoutSettlementEvidence(value: Record<string, unknown> | null | undefined) {
  if (!value || !SETTLEMENT_EVIDENCE_KEYS.some((key) => key in value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SETTLEMENT_EVIDENCE_KEYS.includes(key)))
}

/**
 * Use only where the audited operation must fail closed if evidence cannot be written.
 * Pass the transaction client to commit the row with the change it records.
 */
export async function logAuditStrict(params: AuditParams, db: Pick<typeof prisma, "auditLog"> = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      ...(params.id ? { id: params.id } : {}),
      tenantId: params.tenantId,
      userId: params.userId ?? null,
      userEmail: params.userEmail ?? null,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      oldValue: (params.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      newValue: (withoutSettlementEvidence(params.newValue) ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ipAddress: params.ipAddress ?? null,
    },
  })
}

// Every audit action, one file per domain under lib/registry/audit-actions/
// (merged by scripts/gen-registries.ts; docs/ARCHITECTURE.md, "Registries").
export const AuditAction = AUDIT_ACTIONS
