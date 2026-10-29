/**
 * The daily AuditLog verification: one chainer pass (so nothing committed
 * before the run is left unlinked), then every chain is walked: from its latest
 * checkpoint on weekdays, in full on Sundays (SAST). A chain that holds gets an
 * AUDIT_CHAIN_VERIFIED row and a new checkpoint; one that does not gets an
 * AUDIT_CHAIN_BROKEN row (no checkpoint: it must not bless a broken chain) and a
 * log line. The rows land on the chain they report, and from there reach the
 * lender's SIEM, which is the alert path a bank watches.
 */
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { AuditAction, logAudit } from "@/lib/audit"
import { logger } from "@/lib/observability/logger"
import { PLATFORM_CHAIN } from "./chain-hash"
import { verifyAuditChains, type ChainVerification, type VerifyMode } from "./chain-verify"
import { runChainer } from "./chainer"
import { writeCheckpoints } from "./checkpoint"

export interface VerifyJobResult extends ChainVerification {
  checkpointsWritten: number
}

export function modeFor(now: Date): VerifyMode {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Africa/Johannesburg" }).format(now)
  return weekday === "Sun" ? "full" : "incremental"
}

export async function runAuditChainVerification(opts: { db?: PrismaClient; now?: Date; mode?: VerifyMode; only?: readonly string[] } = {}): Promise<VerifyJobResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const now = opts.now ?? new Date()
  return withoutTenantScope(async () => {
    await runChainer({ db, mode: "full", budgetMs: 10 * 60_000, only: opts.only })
    const result = await verifyAuditChains(db, { mode: opts.mode ?? modeFor(now), now, chainKeys: opts.only })

    for (const b of result.breaks) {
      logger.error("[audit-chain] BROKEN", { ...b })
      await logAudit({
        tenantId: b.chainKey || undefined,
        action: AuditAction.AUDIT_CHAIN_BROKEN,
        entity: "AuditLog",
        entityId: b.auditLogId ?? undefined,
        newValue: { kind: b.kind, chainSeq: b.chainSeq, detail: b.detail },
      })
    }
    const checkpointsWritten = await writeCheckpoints(db, result.verifiedHeads)
    for (const { chainKey, seq } of result.verifiedHeads) {
      if (chainKey === PLATFORM_CHAIN) continue
      await logAudit({ tenantId: chainKey, action: AuditAction.AUDIT_CHAIN_VERIFIED, entity: "AuditLog", newValue: { lastSeq: seq, mode: result.mode } })
    }
    return { ...result, checkpointsWritten }
  })
}
