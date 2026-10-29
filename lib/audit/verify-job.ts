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

export async function runAuditChainVerification(opts: { db?: PrismaClient; now?: Date; mode?: VerifyMode } = {}): Promise<VerifyJobResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const now = opts.now ?? new Date()
  return withoutTenantScope(async () => {
    await runChainer({ db, now, deep: true, budgetMs: 10 * 60_000 })
    const result = await verifyAuditChains(db, { mode: opts.mode ?? modeFor(now), now })

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
    const checkpointsWritten = await writeCheckpoints(db, result.verifiedKeys)
    for (const key of result.verifiedKeys) {
      if (key === PLATFORM_CHAIN) continue
      const [head] = await db.$queryRaw<Array<{ seq: number }>>`SELECT "seq" FROM "AuditChainLink" WHERE "chainKey" = ${key} ORDER BY "seq" DESC LIMIT 1`
      if (!head) continue
      await logAudit({ tenantId: key, action: AuditAction.AUDIT_CHAIN_VERIFIED, entity: "AuditLog", newValue: { lastSeq: head.seq, mode: result.mode } })
    }
    return { ...result, checkpointsWritten }
  })
}
