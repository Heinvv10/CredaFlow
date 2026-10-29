/**
 * The lender's IFRS 9 policy, PD/LGD table and SICR flags: reads and the audited writes.
 * Ifrs9* tables are tenant-scoped: callers run inside the tenant's frame.
 */
import { Prisma } from "@prisma/client"
import { nextPeriodKey } from "@/lib/accounting/period"
import { lockAccounting } from "@/lib/accounting/route-helpers"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { DEFAULT_SETTINGS, type EclParameter, type Ifrs9Settings, type SicrFlagKind, type Stage } from "./types"

type Db = Pick<typeof prisma, "ifrs9Config" | "ifrs9EclParameter">
type Db2 = Pick<typeof prisma, "$transaction">
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface Actor {
  id: string
  email: string
}

export async function loadSettings(db: Pick<Db, "ifrs9Config">, tenantId: string): Promise<Ifrs9Settings> {
  const row = await db.ifrs9Config.findUnique({ where: { tenantId } })
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    enabled: row.enabled, effectiveFromMonth: row.effectiveFromMonth, sicrDpdOver: row.sicrDpdOver, defaultDpd: row.defaultDpd,
    restructuredStage: row.restructuredStage as Stage, debtReviewStage: row.debtReviewStage as Stage,
    stage2ProbationMonths: row.stage2ProbationMonths, stage3ProbationMonths: row.stage3ProbationMonths,
    restructuredProbationMonths: row.restructuredProbationMonths,
    suspensionEnabled: row.suspensionEnabled, suspensionDpd: row.suspensionDpd, suspendOnStage3: row.suspendOnStage3,
    stage3InterestBasis: row.stage3InterestBasis,
  }
}

export interface LedgerPosition {
  /** Net of every closed month's ECL_ALLOWANCE lines and INTEREST_SUSPENSE lines (a credit is negative). */
  allowanceCents: number
  suspenseCents: number
  /** Any IFRS 9 line has been posted (a net-basis adjustment too), whatever the balances now. */
  posted: boolean
}

export async function ledgerPosition(db: Pick<typeof prisma, "$queryRaw">, tenantId: string): Promise<LedgerPosition> {
  const rows = await db.$queryRaw<Array<{ role: string; net: bigint }>>(Prisma.sql`
    SELECT COALESCE("sourceRole", "role") AS "role", SUM("debitCents" - "creditCents")::bigint AS "net" FROM "AccountingJournalLine"
    WHERE "tenantId" = ${tenantId} AND COALESCE("sourceRole", "role") IN ('ECL_ALLOWANCE', 'ECL_EXPENSE', 'INTEREST_SUSPENSE')
    GROUP BY 1
  `)
  const net = (role: string) => Number(rows.find((r) => r.role === role)?.net ?? 0)
  return { allowanceCents: net("ECL_ALLOWANCE"), suspenseCents: net("INTEREST_SUSPENSE"), posted: rows.length > 0 }
}

/** The first accounting month not yet closed, or null when none is knowable yet (no go-live month, nothing closed). */
async function firstUnclosedMonth(tx: Pick<Tx, "accountingExportBatch" | "accountingSettings">, tenantId: string): Promise<string | null> {
  const latest = await tx.accountingExportBatch.findFirst({ where: { tenantId }, orderBy: { periodStart: "desc" }, select: { periodKey: true } })
  if (latest) return nextPeriodKey(latest.periodKey)
  return (await tx.accountingSettings.findUnique({ where: { tenantId }, select: { goLiveMonth: true } }))?.goLiveMonth ?? null
}

export type SaveSettingsResult = { ok: true } | { ok: false; error: string }

const rand = (cents: number) => `R${(Math.abs(cents) / 100).toFixed(2)}`

/**
 * Why a change of policy must wait, given what the ledger already holds, or null. A closed month is final and each month
 * posts only the movement from what was posted, so a change that would strand or double a posted position is refused:
 * switching off while an allowance or interest in suspense is held (it would never be released), moving the first month
 * forward over a held position (the close would carry a frozen one), and changing the Stage 3 interest basis once anything
 * has been posted (the old basis's postings would sit beside the new basis's).
 */
export function policyChangeRefusal(before: Ifrs9Settings, next: Ifrs9Settings, position: LedgerPosition): string | null {
  const held = position.allowanceCents !== 0 || position.suspenseCents !== 0
  if (before.enabled && !next.enabled && held) {
    return `IFRS 9 cannot be switched off while the ledger holds an allowance of ${rand(position.allowanceCents)} and interest in suspense of ${rand(position.suspenseCents)}: they would never be released`
  }
  const forward = next.effectiveFromMonth !== null && (before.effectiveFromMonth === null || next.effectiveFromMonth > before.effectiveFromMonth)
  if (before.enabled && next.enabled && forward && held) {
    return `effectiveFromMonth cannot move forward while the ledger holds an allowance of ${rand(position.allowanceCents)} and interest in suspense of ${rand(position.suspenseCents)}: later months would close on a frozen position`
  }
  if (position.posted && before.stage3InterestBasis !== next.stage3InterestBasis) {
    return "stage3InterestBasis cannot change once IFRS 9 has posted to the ledger: the old basis's entries would sit beside the new one's"
  }
  return null
}

/**
 * Under the accounting lock, so a close cannot interleave. See policyChangeRefusal; and the first month cannot be a
 * month that has already closed.
 */
export async function saveSettings(db: Db2, tenantId: string, next: Ifrs9Settings, actor: Actor): Promise<SaveSettingsResult> {
  return db.$transaction(async (tx) => {
    await lockAccounting(tx, tenantId)
    const before = await loadSettings(tx, tenantId)
    const refusal = policyChangeRefusal(before, next, await ledgerPosition(tx, tenantId))
    if (refusal) return { ok: false, error: refusal }
    if (next.enabled && next.effectiveFromMonth !== null && next.effectiveFromMonth !== before.effectiveFromMonth) {
      const first = await firstUnclosedMonth(tx, tenantId)
      if (first !== null && next.effectiveFromMonth < first) return { ok: false, error: `effectiveFromMonth must be ${first} or later: earlier months are closed` }
    }
    await tx.ifrs9Config.upsert({ where: { tenantId }, create: { tenantId, ...next, updatedById: actor.id }, update: { ...next, updatedById: actor.id } })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.IFRS9_SETTINGS_UPDATED,
      entity: "Ifrs9Config", entityId: tenantId, oldValue: { ...before }, newValue: { ...next },
    }, tx)
    return { ok: true }
  })
}

export async function loadParameters(db: Pick<Db, "ifrs9EclParameter">, tenantId: string): Promise<EclParameter[]> {
  const rows = await db.ifrs9EclParameter.findMany({ where: { tenantId }, orderBy: [{ scopeKey: "asc" }, { stage: "asc" }] })
  return rows.map((r) => ({ scopeKey: r.scopeKey, stage: r.stage as Stage, pdBps: r.pdBps, lgdBps: r.lgdBps }))
}

/** Replaces the whole table: a row left out is removed. */
export async function replaceParameters(db: Db2, tenantId: string, rows: readonly EclParameter[], actor: Actor): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await loadParameters(tx, tenantId)
    await tx.ifrs9EclParameter.deleteMany({ where: { tenantId } })
    await tx.ifrs9EclParameter.createMany({ data: rows.map((r) => ({ tenantId, ...r, updatedById: actor.id })) })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.IFRS9_PARAMETERS_REPLACED,
      entity: "Ifrs9EclParameter", entityId: tenantId, oldValue: { parameters: before }, newValue: { parameters: [...rows] },
    }, tx)
  })
}

/** False when the loan is not this lender's. */
export async function setSicrFlag(db: Db2, tenantId: string, loanId: string, kind: SicrFlagKind, reason: string, actor: Actor): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true } })
    if (!loan) return false
    const flag = await tx.ifrs9SicrFlag.create({ data: { tenantId, loanId, kind, reason, setById: actor.id } })
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.IFRS9_SICR_FLAG_SET,
      entity: "Ifrs9SicrFlag", entityId: flag.id, newValue: { loanId, kind, reason },
    }, tx)
    return true
  })
}

/** False when no active flag of that id on that loan is the lender's. */
export async function clearSicrFlag(db: Db2, tenantId: string, flagId: string, actor: Actor): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const done = await tx.ifrs9SicrFlag.updateMany({ where: { id: flagId, tenantId, clearedAt: null }, data: { clearedAt: new Date(), clearedById: actor.id } })
    if (done.count === 0) return false
    await logAuditStrict({
      tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.IFRS9_SICR_FLAG_CLEARED,
      entity: "Ifrs9SicrFlag", entityId: flagId, newValue: { cleared: true },
    }, tx)
    return true
  })
}
