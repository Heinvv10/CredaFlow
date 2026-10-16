/**
 * Before anything is sent again, IsaFlow is read back. A FAILED push being
 * pushed again, or a NEEDS_REVIEW one being checked, is claimed SENDING, then
 * the drafts dated the request's day are listed: one carrying the batch's
 * memo tag and exactly the stored lines IS the push (PUSHED, foundOnReadBack).
 * Otherwise the stored request is resent byte for byte under the same key,
 * so a draft IsaFlow did create is replayed, not duplicated.
 *
 * Known limit (IsaFlow's registry, registry.ts:146-157): a draft a person
 * deleted in IsaFlow is not recreated by a resend; IsaFlow replays the stored
 * result and the push records the deleted draft's id.
 */
import { AuditAction } from "@/lib/audit"
import { IsaFlowError, mcpTransport, type IsaFlowHttp } from "./client"
import { isaflowTarget, markIsaFlowNeedsReconnect, type Actor } from "./connection"
import { findPushedDraft } from "./journal"
import { audit, markStaleIsaFlowPush, recordOutcome, refused, sendClaimed, type PushDb, type PushOutcome } from "./push-record"

export async function retryIsaFlowPush(db: PushDb, args: { tenantId: string; batchId: string; actor: Actor; from: "FAILED" | "NEEDS_REVIEW" }, http: IsaFlowHttp = {}): Promise<PushOutcome> {
  const push = await db.accountingIsaFlowPush.findFirst({ where: { batchId: args.batchId, tenantId: args.tenantId }, select: { status: true, requestJson: true, isaflowCompanyId: true } })
  if (!push || push.status !== args.from) return refused(409, "This push changed meanwhile; reload")
  let target: Awaited<ReturnType<typeof isaflowTarget>>
  try {
    target = await isaflowTarget(db, args.tenantId)
  } catch (error) {
    if (error instanceof IsaFlowError) return refused(409, "Connect IsaFlow first (Settings → Integrations)")
    throw error
  }
  if (target.companyId !== push.isaflowCompanyId) {
    return refused(409, "IsaFlow is now connected to a different company than this push was built for; resolve it after checking both companies")
  }

  const claimed = await db.$transaction(async (tx) => {
    const moved = await tx.accountingIsaFlowPush.updateMany({
      where: { batchId: args.batchId, tenantId: args.tenantId, status: args.from },
      data: { status: "SENDING", error: null, pushedById: args.actor.id },
    })
    if (moved.count !== 1) return false
    await audit(tx, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_ISAFLOW_PUSH_CLAIMED, { retryFrom: args.from })
    return true
  })
  if (!claimed) return refused(409, "This push changed meanwhile; reload")

  const isa = mcpTransport(target, http)
  const date = (JSON.parse(push.requestJson) as { date: string }).date
  let match: ReturnType<typeof findPushedDraft>
  try {
    const drafts = await isa.listDraftJournals(date)
    match = findPushedDraft(drafts, push.requestJson)
    await audit(db, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_ISAFLOW_PUSH_READBACK, {
      date, drafts: drafts.length, found: match.found?.id ?? null, conflicting: match.conflicting?.id ?? null,
    })
  } catch (error) {
    if (!(error instanceof IsaFlowError)) throw error
    if (error.kind === "auth") await markIsaFlowNeedsReconnect(db, args.tenantId)
    // Nothing was sent: the push goes back to where it was.
    const result: PushOutcome = { ok: false, httpStatus: 502, status: args.from, error: `Could not read IsaFlow back, so nothing was resent. ${error.message}`.slice(0, 500) }
    await recordOutcome(db, args, result)
    return result
  }
  if (match.found) {
    const result: PushOutcome = { ok: true, status: "PUSHED", journalId: match.found.id, foundOnReadBack: true }
    await recordOutcome(db, args, result)
    return result
  }
  if (match.conflicting) {
    const result: PushOutcome = {
      ok: false, httpStatus: 409, status: "NEEDS_REVIEW",
      error: `IsaFlow holds a draft tagged with this batch (${match.conflicting.entryNumber}) whose lines differ from what was sent; check it in IsaFlow, then resolve`,
    }
    await recordOutcome(db, args, result)
    return result
  }
  return sendClaimed(db, { ...args, argsJson: push.requestJson }, isa)
}

/**
 * The staff "check" on a push without an answer: a SENDING claim older than
 * 10 minutes goes to review, and a push in review is read back (and, if IsaFlow
 * does not hold it, resent under its key).
 */
export async function checkIsaFlowPush(db: PushDb, args: { tenantId: string; batchId: string; actor: Actor; now?: Date }, http: IsaFlowHttp = {}): Promise<PushOutcome> {
  const push = await db.accountingIsaFlowPush.findFirst({ where: { batchId: args.batchId, tenantId: args.tenantId }, select: { status: true } })
  if (!push) return refused(404, "No IsaFlow push of this batch")
  if (push.status === "SENDING" && !(await markStaleIsaFlowPush(db, args))) {
    return refused(409, "The push is still within its 10 minutes; check again later")
  }
  if (push.status === "PUSHED") return refused(409, "This batch is already in IsaFlow")
  if (push.status === "FAILED") return refused(409, "This push failed; push it again (IsaFlow is read back first)")
  return retryIsaFlowPush(db, { tenantId: args.tenantId, batchId: args.batchId, actor: args.actor, from: "NEEDS_REVIEW" }, http)
}
