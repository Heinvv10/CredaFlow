/**
 * Dealer payable runs (SLICE5.md "Commission, runs and journals"): a batch of
 * one dealer's commission lines paid to its APPROVED bank account.
 *
 *   create   (manage_dealers)        a month-end period already ended; the
 *                                    lines ./payable-run-lines.ts selects
 *                                    (clawbacks netted with their commission);
 *                                    refused when they net to nothing or less
 *                                    (the lines wait for a later run)
 *   approve  (decide_asset_finance)  by a user other than the creator
 *                                    (CHECK DealerPayableRun_four_eyes)
 *   release  (decide_asset_finance)  records the lender's own EFT reference;
 *                                    no bank rail. Only while the account the
 *                                    run names is still APPROVED
 *   cancel   (decide_asset_finance)  pending or approved; frees its lines
 *
 * Each locks the run (or, to create, the dealer) row and is audited. The
 * database enforces every rule again (guardDealerPayableRun,
 * guardDealerPayableRunLine and the netting triggers); a refusal it raises
 * is answered 409 with its own sentence.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "@/lib/asset-finance/dates"
import type { StaffActor } from "./actor"
import { selectRunLines, type RunCandidate } from "./payable-run-lines"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"
import { dealerGuardSentence } from "./staff-guard-message"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type RunResult<K extends string, X = never> = { kind: K; runId: string } | X | DealerRefusal
type SelfApproval = { kind: "self_approval" }

/** "YYYY-MM-DD", the last day of its month, not after today (SAST). */
export function parsePeriodEnd(value: unknown, today = sastCalendarDate(new Date())): string | DealerRefusal {
  if (typeof value !== "string") return dealerRefused(400, "periodEnd must be a month-end date (YYYY-MM-DD)")
  let day: number
  try {
    day = toDayNumber(value, "periodEnd")
  } catch {
    return dealerRefused(400, "periodEnd must be a month-end date (YYYY-MM-DD)")
  }
  if (!fromDayNumber(day + 1).endsWith("-01")) return dealerRefused(400, "periodEnd must be the last day of a month")
  if (value > today) return dealerRefused(400, "A payable run covers a period that has ended")
  return value
}

/** The latest month end a run can cover on `today`: today when it is a month end, else last month's. */
export function latestPeriodEnd(today = sastCalendarDate(new Date())): string {
  const day = toDayNumber(today)
  if (fromDayNumber(day + 1).endsWith("-01")) return today
  return fromDayNumber(toDayNumber(`${today.slice(0, 7)}-01`) - 1)
}

async function candidates(tx: Tx, tenantId: string, dealerId: string, periodEnd: string): Promise<RunCandidate[]> {
  const rows = await tx.$queryRaw<Array<{
    id: string; kind: "EARNED" | "REVERSED"; netCents: number; vatCents: number; grossCents: number
    reversalId: string | null; reversalOn: Date | null; reversalLive: boolean | null
  }>>(Prisma.sql`
    SELECT l."id", l."kind"::text AS "kind", l."netCents", l."vatCents", l."grossCents",
      r."id" AS "reversalId", r."effectiveOn" AS "reversalOn",
      CASE WHEN r."id" IS NULL THEN NULL ELSE "dealerCommissionLineLive"(l."tenantId", r."id") END AS "reversalLive"
    FROM "DealerCommissionLine" l
    LEFT JOIN "DealerCommissionLine" r ON r."tenantId" = l."tenantId" AND r."reversesLineId" = l."id"
    WHERE l."tenantId" = ${tenantId} AND l."dealerId" = ${dealerId} AND l."effectiveOn" <= ${dbDate(periodEnd)}
      AND NOT "dealerCommissionLineLive"(l."tenantId", l."id")
    ORDER BY l."effectiveOn", l."createdAt", l."id"
  `)
  return rows.map((row) => ({
    id: row.id, kind: row.kind, netCents: row.netCents, vatCents: row.vatCents, grossCents: row.grossCents,
    reversal: row.reversalId && row.reversalOn
      ? { id: row.reversalId, effectiveOn: isoOfDbDate(row.reversalOn), live: row.reversalLive === true }
      : null,
  }))
}

/** Runs `write`, answering a refusal the database raised with its own sentence. */
async function guarded<T>(write: () => Promise<T>): Promise<T | DealerRefusal> {
  try {
    return await write()
  } catch (error) {
    const sentence = dealerGuardSentence(error)
    if (sentence) return dealerRefused(409, sentence)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return dealerRefused(409, "The dealer already has a live run for this period")
    }
    throw error
  }
}

export async function createPayableRun(staff: StaffActor, dealerId: string, body: { periodEnd?: unknown }): Promise<RunResult<"created">> {
  const periodEnd = parsePeriodEnd(body.periodEnd)
  if (typeof periodEnd !== "string") return periodEnd
  const { tenantId } = staff
  return guarded(() => prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Dealer" WHERE "id" = ${dealerId} AND "tenantId" = ${tenantId} FOR UPDATE
    `)
    if (locked.length === 0) return dealerMiss("Dealer")
    const account = await tx.dealerBankAccount.findFirst({ where: { tenantId, dealerId, status: "APPROVED" }, select: { id: true } })
    if (!account) return dealerRefused(409, "The dealer has no approved bank account")
    const selection = selectRunLines(await candidates(tx, tenantId, dealerId, periodEnd), periodEnd)
    if (selection.lineIds.length === 0) return dealerRefused(409, "No commission is due to this dealer by that period end")
    if (selection.totalNetCents <= 0) {
      return dealerRefused(409, "The lines due net to nothing or less (clawbacks); they wait for a later run")
    }
    const run = await tx.dealerPayableRun.create({
      data: {
        tenantId, dealerId, periodEnd: dbDate(periodEnd), bankAccountId: account.id, createdById: staff.userId,
        totalNetCents: selection.totalNetCents, totalVatCents: selection.totalVatCents, totalGrossCents: selection.totalGrossCents,
      },
      select: { id: true },
    })
    // One INSERT per line, in order: a clawback is linked before its commission (DealerPayableRunLine_netting).
    for (const lineId of selection.lineIds) {
      await tx.dealerPayableRunLine.create({ data: { tenantId, runId: run.id, lineId } })
    }
    await logAuditStrict({
      tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_PAYABLE_RUN_CREATED, entity: "DealerPayableRun", entityId: run.id,
      newValue: {
        dealerId, periodEnd, bankAccountId: account.id, lineIds: selection.lineIds,
        totalNetCents: selection.totalNetCents, totalVatCents: selection.totalVatCents, totalGrossCents: selection.totalGrossCents,
      },
    }, tx)
    return { kind: "created" as const, runId: run.id }
  }))
}

type LockedRun = { id: string; dealerId: string; status: string; createdById: string; bankAccountId: string }

async function lockRun(tx: Tx, tenantId: string, runId: string): Promise<LockedRun | null> {
  const rows = await tx.$queryRaw<LockedRun[]>(Prisma.sql`
    SELECT "id", "dealerId", "status"::text AS "status", "createdById", "bankAccountId"
    FROM "DealerPayableRun" WHERE "id" = ${runId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  return rows[0] ?? null
}

/** Moves a locked run on and audits it; `check` refuses before any write. */
async function moveRun<K extends string, X = never>(
  staff: StaffActor,
  runId: string,
  kind: K,
  action: string,
  check: (run: LockedRun, tx: Tx) => Promise<DealerRefusal | X | null>,
  data: Prisma.DealerPayableRunUncheckedUpdateInput,
  detail: Record<string, unknown> = {},
): Promise<RunResult<K, X>> {
  return guarded(() => prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, staff.tenantId, runId)
    if (!run) return dealerMiss("Payable run")
    const refused = await check(run, tx)
    if (refused) return refused
    const updated = await tx.dealerPayableRun.update({ where: { id: run.id, tenantId: staff.tenantId }, data, select: { status: true } })
    await logAuditStrict({
      tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action, entity: "DealerPayableRun", entityId: run.id,
      oldValue: { status: run.status }, newValue: { dealerId: run.dealerId, status: updated.status, ...detail },
    }, tx)
    return { kind, runId: run.id }
  }))
}

const notIn = (run: LockedRun, statuses: string[], verb: string) =>
  statuses.includes(run.status) ? null : dealerRefused(409, `A ${run.status.toLowerCase().replace("_", " ")} run cannot be ${verb}`)

export function approvePayableRun(staff: StaffActor, runId: string): Promise<RunResult<"approved", SelfApproval>> {
  return moveRun<"approved", SelfApproval>(staff, runId, "approved", AuditAction.DEALER_PAYABLE_RUN_APPROVED, async (run) => {
    const refused = notIn(run, ["PENDING_APPROVAL"], "approved")
    if (refused) return refused
    return run.createdById === staff.userId ? { kind: "self_approval" as const } : null
  }, { status: "APPROVED", approvedById: staff.userId, approvedAt: new Date() })
}

export function releasePayableRun(staff: StaffActor, runId: string, body: { releaseReference?: unknown }): Promise<RunResult<"released">> {
  const reference = typeof body.releaseReference === "string" ? body.releaseReference.trim() : ""
  if (reference.length < 1 || reference.length > 100) {
    return Promise.resolve(dealerRefused(400, "releaseReference must be the lender's EFT reference (1-100 characters)"))
  }
  return moveRun<"released">(staff, runId, "released", AuditAction.DEALER_PAYABLE_RUN_RELEASED, async (run, tx) => {
    const refused = notIn(run, ["APPROVED"], "released")
    if (refused) return refused
    const account = await tx.dealerBankAccount.findFirst({ where: { id: run.bankAccountId, tenantId: staff.tenantId }, select: { status: true } })
    if (account?.status !== "APPROVED") {
      return dealerRefused(409, "The run's bank account is no longer the dealer's approved account: cancel the run and create a new one")
    }
    return null
  }, {
    status: "RELEASED", releaseReference: reference, releasedAt: new Date(), releasedById: staff.userId,
  }, { releaseReference: reference })
}

export function cancelPayableRun(staff: StaffActor, runId: string): Promise<RunResult<"cancelled">> {
  return moveRun<"cancelled">(staff, runId, "cancelled", AuditAction.DEALER_PAYABLE_RUN_CANCELLED,
    async (run) => notIn(run, ["PENDING_APPROVAL", "APPROVED"], "cancelled"),
    { status: "CANCELLED", cancelledAt: new Date(), cancelledById: staff.userId })
}
