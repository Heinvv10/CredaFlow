/**
 * The daily AuditLog chain verification: walks every chain, records a
 * AUDIT_CHAIN_VERIFIED row for each lender that passed (so the lender holds
 * evidence the check ran) and a AUDIT_CHAIN_BROKEN row for each chain that did
 * not, and logs the break for the operator's alerting. The rows land on the
 * chain being reported, and from there go to the lender's SIEM, which is the
 * alert path a bank watches.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { verifyAuditChains, type ChainVerification } from "./chain-verify"

export async function runAuditChainVerification(): Promise<ChainVerification> {
  const result = await verifyAuditChains(prisma)
  const broken = new Map(result.breaks.map((b) => [b.chainKey, b]))

  for (const b of result.breaks) {
    console.error("[audit-chain] BROKEN", b)
    await logAudit({
      tenantId: b.chainKey || undefined,
      action: AuditAction.AUDIT_CHAIN_BROKEN,
      entity: "AuditLog",
      entityId: b.auditLogId ?? undefined,
      newValue: { kind: b.kind, chainSeq: b.chainSeq, detail: b.detail },
    })
  }

  // One pass row per lender with a chain that held (tenants with no audit rows have none to report).
  const heads = await prisma.auditChainHead.findMany({ select: { chainKey: true, lastSeq: true } })
  for (const head of heads) {
    if (head.chainKey === "" || broken.has(head.chainKey)) continue
    await logAudit({
      tenantId: head.chainKey,
      action: AuditAction.AUDIT_CHAIN_VERIFIED,
      entity: "AuditLog",
      newValue: { lastSeq: head.lastSeq },
    })
  }
  return result
}
