/**
 * Pushing a closed batch to IsaFlow as ONE draft journal, at most once.
 * Mirrors lib/accounting/xero/push.ts (claim before send, stale SENDING to
 * review, a person's resolution), with one addition IsaFlow allows: a stable
 * idempotency key. The request is built once, stored with the claim, and every
 * later send is the same bytes under `credaflow:batch:<batchId>`, which IsaFlow
 * replays instead of creating a second draft (contract.ts, registry.ts:146-165).
 *
 * Order, and nothing is sent or claimed before its step passes:
 *  1. the CLOSED batch, digest-checked (loadBatchLines);
 *  2. every line's role has a stored mapping whose code is the line's code, and
 *     no line carries a tax code (IsaFlow lines carry none; VAT is its own line);
 *  3. every code exists once and is active in IsaFlow's chart (codes become
 *     account ids here); otherwise 422 listing them, nothing claimed;
 *  4. the request, built once: net per account, rands to 2 dp, period end;
 *  5. claim SENDING with the request; 6. send; 7. PUSHED, FAILED or NEEDS_REVIEW.
 *
 * Before any retry (push of a FAILED batch, check of a NEEDS_REVIEW one) the
 * day's drafts are read back (./retry.ts); a draft with the memo tag and the
 * same lines is the push.
 */
import { Prisma } from "@prisma/client"
import { AuditAction } from "@/lib/audit"
import type { StoredLine } from "../csv"
import { parsePeriodKey } from "../period"
import { loadBatchLines } from "../store"
import { IsaFlowError, mcpTransport, type IsaFlowHttp } from "./client"
import { isaflowTarget, markIsaFlowNeedsReconnect, type Actor } from "./connection"
import { buildDraftJournal, isaflowIdempotencyKey, netByAccount, resolveChart } from "./journal"
import { audit, markStaleIsaFlowPush, refused, sendClaimed, type PushDb, type PushOutcome } from "./push-record"
import { retryIsaFlowPush } from "./retry"

/** Step 2: why this month's lines cannot be pushed as stored, or null. */
export async function mappingRefusal(db: Pick<PushDb, "accountingAccountMapping">, tenantId: string, lines: StoredLine[]): Promise<string | null> {
  if (lines.some((l) => l.taxCode)) {
    return "This month's lines carry tax codes (set on the mapping for Xero); IsaFlow journals carry none. Post this month from the CSV"
  }
  const stored = new Map((await db.accountingAccountMapping.findMany({ where: { tenantId }, select: { role: true, accountCode: true } })).map((m) => [m.role as string, m.accountCode]))
  const bad = [...new Set(lines.map((l) => `${l.role ?? "?"}|${l.accountCode}`))]
    .map((k) => k.split("|"))
    .filter(([role, code]) => stored.get(role) !== code)
    .map(([role, code]) => `${role} (${code})`)
    .sort()
  if (bad.length === 0) return null
  return `These roles have no stored mapping to the code this month was closed with: ${bad.join(", ")}. Map them to your IsaFlow accounts before closing a month, or post this month from the CSV`
}

export async function pushBatchToIsaFlow(db: PushDb, args: { tenantId: string; batchId: string; actor: Actor }, http: IsaFlowHttp = {}): Promise<PushOutcome> {
  const batch = await db.accountingExportBatch.findFirst({ where: { id: args.batchId, tenantId: args.tenantId, status: "CLOSED" }, select: { id: true, periodKey: true } })
  if (!batch) return refused(404, "Closed batch not found")
  const lines = await loadBatchLines(db, args.tenantId, batch.id)
  const period = parsePeriodKey(batch.periodKey)
  if (!lines || !period) return refused(404, "Closed batch not found")
  const unmapped = await mappingRefusal(db, args.tenantId, lines)
  if (unmapped) return refused(422, unmapped)

  const existing = await db.accountingIsaFlowPush.findUnique({ where: { batchId: batch.id }, select: { status: true } })
  if (existing?.status === "PUSHED") return refused(409, "This batch is already in IsaFlow")
  if (existing?.status === "NEEDS_REVIEW") return refused(409, "A previous push has an unknown outcome; check it first")
  if (existing?.status === "SENDING") {
    return (await markStaleIsaFlowPush(db, args))
      ? { ok: false, httpStatus: 409, status: "NEEDS_REVIEW", error: "An earlier push never recorded IsaFlow's answer; check it" }
      : refused(409, "A push of this batch is in progress")
  }
  if (existing?.status === "FAILED") return retryIsaFlowPush(db, { ...args, from: "FAILED" }, http)

  let target: Awaited<ReturnType<typeof isaflowTarget>>
  try {
    target = await isaflowTarget(db, args.tenantId)
  } catch (error) {
    if (error instanceof IsaFlowError) return refused(409, "Connect IsaFlow first (Settings → Integrations)")
    throw error
  }
  const isa = mcpTransport(target, http)
  const net = netByAccount(lines)
  let chart: ReturnType<typeof resolveChart>
  try {
    chart = resolveChart(net.map((l) => l.code), await isa.listGlAccounts())
  } catch (error) {
    if (!(error instanceof IsaFlowError)) throw error
    if (error.kind === "auth") await markIsaFlowNeedsReconnect(db, args.tenantId)
    return refused(502, `Could not read IsaFlow's chart of accounts; nothing was sent. ${error.message}`)
  }
  if (!chart.ok) {
    const list = [...chart.missing.map((c) => `${c} (not in IsaFlow)`), ...chart.inactive.map((c) => `${c} (inactive)`), ...chart.ambiguous.map((c) => `${c} (more than one account)`)]
    return {
      ok: false, httpStatus: 422, status: null, codes: { missing: chart.missing, inactive: chart.inactive, ambiguous: chart.ambiguous },
      error: `IsaFlow cannot take these account codes: ${list.join(", ")}. Fix the chart in IsaFlow, then push again`,
    }
  }
  let argsJson: string, sha256: string
  try {
    ({ argsJson, sha256 } = buildDraftJournal({ batchId: batch.id, label: period.label, date: period.lastDay, companyId: target.companyId, lines: net, accountIds: chart.ids }))
  } catch (error) {
    if (error instanceof IsaFlowError) return refused(422, error.message)
    throw error
  }

  // Claim before send.
  const claimed = await db.$transaction(async (tx) => {
    try {
      await tx.accountingIsaFlowPush.create({
        data: {
          tenantId: args.tenantId, batchId: batch.id, status: "SENDING", externalRef: batch.id, idempotencyKey: isaflowIdempotencyKey(batch.id),
          requestJson: argsJson, requestSha256: sha256, isaflowCompanyId: target.companyId, pushedById: args.actor.id,
        },
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false
      throw error
    }
    await audit(tx, args.tenantId, args.actor, batch.id, AuditAction.ACCOUNTING_ISAFLOW_PUSH_CLAIMED, {
      isaflowCompanyId: target.companyId, idempotencyKey: isaflowIdempotencyKey(batch.id), requestSha256: sha256, lines: net.length,
    })
    return true
  })
  if (!claimed) return refused(409, "A push of this batch is in progress")
  return sendClaimed(db, { ...args, argsJson }, isa)
}

/** A person's answer to an unknown outcome they checked in IsaFlow. */
export async function resolveIsaFlowPush(db: PushDb, args: {
  tenantId: string
  batchId: string
  outcome: "pushed" | "not_pushed"
  journalId: string | null
  note: string
  actor: Actor
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const moved = await tx.accountingIsaFlowPush.updateMany({
      where: { batchId: args.batchId, tenantId: args.tenantId, status: "NEEDS_REVIEW" },
      data: args.outcome === "pushed"
        ? { status: "PUSHED", isaflowJournalId: args.journalId, resolvedById: args.actor.id, resolutionNote: args.note }
        : { status: "FAILED", resolvedById: args.actor.id, resolutionNote: args.note },
    })
    if (moved.count !== 1) return false
    await audit(tx, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_ISAFLOW_PUSH_RESOLVED, { outcome: args.outcome, journalId: args.journalId, note: args.note })
    return true
  })
}
