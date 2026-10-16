/**
 * The IsaFlow push's state changes, shared by the first push (./push.ts) and
 * the read-back retry (./retry.ts): every one is a conditional update of the
 * AccountingIsaFlowPush row (guardAccountingIsaFlowPush decides what may
 * follow what) together with its audit row.
 */
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { IsaFlowError, type IsaFlowTransport } from "./client"
import { markIsaFlowNeedsReconnect, type Actor } from "./connection"

export type PushDb = Pick<typeof prisma,
  "accountingIsaFlowPush" | "accountingExportBatch" | "accountingJournalLine" | "accountingAccountMapping" | "accountingLedgerEntry"
  | "accountingSettings" | "loan" | "isaFlowConnection" | "auditLog" | "$transaction" | "$queryRaw">

export const STALE_SENDING_MS = 10 * 60 * 1000

export type PushOutcome =
  | { ok: true; status: "PUSHED"; journalId: string; foundOnReadBack: boolean }
  | { ok: false; httpStatus: number; status: "FAILED" | "NEEDS_REVIEW" | null; error: string; codes?: { missing: string[]; inactive: string[]; ambiguous: string[] } }

export const refused = (httpStatus: number, error: string): PushOutcome => ({ ok: false, httpStatus, status: null, error })

export async function audit(db: Pick<typeof prisma, "auditLog">, tenantId: string, actor: Actor, batchId: string, action: string, newValue: Record<string, unknown>) {
  await logAuditStrict({ tenantId, userId: actor.id, userEmail: actor.email, action, entity: "AccountingExportBatch", entityId: batchId, newValue }, db)
}

/** An auth refusal while pushing: the connection needs a new token (audited, as every such path is). */
export async function dropIsaFlowToken(db: PushDb, args: { tenantId: string; actor: Actor }, reason: string): Promise<void> {
  await db.$transaction((tx) => markIsaFlowNeedsReconnect(tx, { tenantId: args.tenantId, actor: args.actor, reason }))
}

/** A SENDING claim older than STALE_SENDING_MS has no recorded answer: it waits for a check. */
export async function markStaleIsaFlowPush(db: PushDb, args: { tenantId: string; batchId: string; actor: Actor; now?: Date }): Promise<boolean> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - STALE_SENDING_MS)
  return db.$transaction(async (tx) => {
    const moved = await tx.accountingIsaFlowPush.updateMany({
      where: { batchId: args.batchId, tenantId: args.tenantId, status: "SENDING", updatedAt: { lt: cutoff } },
      data: { status: "NEEDS_REVIEW", error: "The push never recorded IsaFlow's answer; check reads IsaFlow back before anything is resent" },
    })
    if (moved.count !== 1) return false
    await audit(tx, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_ISAFLOW_PUSH_RESULT, { status: "NEEDS_REVIEW", reason: "stale_sending" })
    return true
  })
}

/**
 * Step 6 and 7: send the stored request, record what happened. The row must be
 * SENDING (claimed by the caller). `confirm` (a resend) says why the draft
 * IsaFlow answered with cannot be recorded as the push, or null: it then waits
 * for a person instead.
 */
export async function sendClaimed(
  db: PushDb,
  args: { tenantId: string; batchId: string; actor: Actor; argsJson: string },
  isa: IsaFlowTransport,
  confirm?: (journalId: string) => Promise<string | null>,
): Promise<PushOutcome> {
  let result: PushOutcome
  try {
    const created = await isa.createDraftJournal(args.argsJson)
    const problem = confirm ? await confirm(created.id) : null
    result = problem
      ? { ok: false, httpStatus: 409, status: "NEEDS_REVIEW", error: problem.slice(0, 500) }
      : { ok: true, status: "PUSHED", journalId: created.id, foundOnReadBack: false }
  } catch (error) {
    const isaflow = error instanceof IsaFlowError ? error : null
    if (isaflow?.kind === "auth") await dropIsaFlowToken(db, args, isaflow.message)
    const definite = isaflow !== null && isaflow.kind !== "unknown"
    result = { ok: false, httpStatus: 502, status: definite ? "FAILED" : "NEEDS_REVIEW", error: (isaflow?.message ?? "IsaFlow push failed").slice(0, 500) }
  }
  await recordOutcome(db, args, result)
  return result
}

export async function recordOutcome(db: PushDb, args: { tenantId: string; batchId: string; actor: Actor }, result: PushOutcome): Promise<void> {
  const status = result.ok ? "PUSHED" : result.status!
  await db.$transaction(async (tx) => {
    await tx.accountingIsaFlowPush.updateMany({
      where: { batchId: args.batchId, tenantId: args.tenantId, status: "SENDING" },
      data: result.ok
        ? { status, isaflowJournalId: result.journalId, foundOnReadBack: result.foundOnReadBack, error: null }
        : { status, error: result.error },
    })
    await audit(tx, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_ISAFLOW_PUSH_RESULT, result.ok
      ? { status, journalId: result.journalId, foundOnReadBack: result.foundOnReadBack }
      : { status, error: result.error })
  })
}
