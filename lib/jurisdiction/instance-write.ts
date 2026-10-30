/**
 * The only writer of InstanceJurisdiction after the migration: an OPERATOR
 * action (scripts/lender/set-instance-jurisdiction-cli.ts, and the demo seed),
 * never reachable from a request. It is refused once any loan application or
 * loan has ever existed (and the database refuses it too: guardInstanceJurisdictionChange,
 * which remembers the first one in frozenAt), because money, documents and gates have all
 * been decided under the old value.
 *
 * It also moves every existing TenantConfig to the new value in the same
 * transaction: a deferred database check requires them to agree at commit.
 * Run it before onboarding lenders.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { parseCurrency, parseJurisdiction } from "./profiles"

export type InstanceWriteResult =
  | { ok: true; changed: boolean; jurisdiction: string; currency: string }
  | { ok: false; error: string }

const MAX_REASON = 500

export async function setInstanceJurisdiction(
  db: Pick<PrismaClient, "$transaction">,
  input: { jurisdiction: unknown; currency: unknown; actor: string; reason: unknown },
): Promise<InstanceWriteResult> {
  let jurisdiction, currency
  try {
    jurisdiction = parseJurisdiction(input.jurisdiction)
    currency = parseCurrency(input.currency)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (jurisdiction === "ZA" && currency !== "ZAR") return { ok: false, error: "A ZA instance is billed in ZAR only" }
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (!reason || reason.length > MAX_REASON) return { ok: false, error: "A reason (up to 500 characters) is required" }
  const actor = input.actor.trim()
  if (!actor) return { ok: false, error: "An actor is required" }

  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<InstanceWriteResult> => {
    // The lock every instance guard takes (and every application / loan insert holds shared until
    // it commits): taken first, the counts below include inserts that were in flight, and
    // READ COMMITTED (stated, not assumed) makes them read what committed while we waited.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'))`
    const before = await tx.instanceJurisdiction.findUnique({ where: { id: 1 } })
    if (before && before.jurisdiction === jurisdiction && before.currency === currency) {
      return { ok: true, changed: false, jurisdiction, currency }
    }
    const [applications, loans] = await Promise.all([tx.loanApplication.count(), tx.loan.count()])
    if (applications + loans > 0 || before?.frozenAt) {
      return {
        ok: false,
        error: `This instance already has ${applications} loan application(s) and ${loans} loan(s)${before?.frozenAt ? " (it has had them before)" : ""}; its jurisdiction can no longer change. Use a new instance.`,
      }
    }
    await tx.instanceJurisdiction.upsert({
      where: { id: 1 },
      update: { jurisdiction, currency, setBy: actor, setAt: new Date() },
      create: { id: 1, jurisdiction, currency, setBy: actor },
    })
    const moved = await tx.tenantConfig.updateMany({ data: { jurisdiction, currency } })
    // The database re-checks that every lender equals the instance at COMMIT (a deferred
    // trigger). Prisma can swallow an error raised at commit, so run the check now, inside
    // the transaction, where a failure is an error and rolls it back.
    await tx.$executeRaw`SET CONSTRAINTS "InstanceJurisdiction_configs_agree" IMMEDIATE`
    await logAuditStrict({
      action: AuditAction.INSTANCE_JURISDICTION_SET,
      entity: "InstanceJurisdiction",
      entityId: "1",
      userEmail: actor,
      oldValue: before ? { jurisdiction: before.jurisdiction, currency: before.currency } : null,
      newValue: { jurisdiction, currency, reason, lendersMoved: moved.count },
    }, tx as unknown as Parameters<typeof logAuditStrict>[1]) // a plain-client transaction, as the lender CLIs pass
    return { ok: true, changed: true, jurisdiction, currency }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
}
