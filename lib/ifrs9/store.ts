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

/** The allowance the ledger holds now for the lender: the net of every closed month's ECL_ALLOWANCE lines (a credit is negative). */
export async function postedAllowanceCents(db: Pick<typeof prisma, "$queryRaw">, tenantId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ net: bigint | null }>>(Prisma.sql`
    SELECT SUM("debitCents" - "creditCents")::bigint AS "net" FROM "AccountingJournalLine"
    WHERE "tenantId" = ${tenantId} AND COALESCE("sourceRole", "role") = 'ECL_ALLOWANCE'
  `)
  return Number(rows[0]?.net ?? 0)
}

/** The first accounting month not yet closed, or null when none is knowable yet (no go-live month, nothing closed). */
async function firstUnclosedMonth(tx: Pick<Tx, "accountingExportBatch" | "accountingSettings">, tenantId: string): Promise<string | null> {
  const latest = await tx.accountingExportBatch.findFirst({ where: { tenantId }, orderBy: { periodStart: "desc" }, select: { periodKey: true } })
  if (latest) return nextPeriodKey(latest.periodKey)
  return (await tx.accountingSettings.findUnique({ where: { tenantId }, select: { goLiveMonth: true } }))?.goLiveMonth ?? null
}

export type SaveSettingsResult = { ok: true } | { ok: false; error: string }

/**
 * Under the accounting lock, so a close cannot interleave. IFRS 9 cannot be switched off while the ledger holds an
 * allowance (it would never be released), and its first month cannot be a month that has already closed.
 */
export async function saveSettings(db: Db2, tenantId: string, next: Ifrs9Settings, actor: Actor): Promise<SaveSettingsResult> {
  return db.$transaction(async (tx) => {
    await lockAccounting(tx, tenantId)
    const before = await loadSettings(tx, tenantId)
    if (before.enabled && !next.enabled) {
      const held = await postedAllowanceCents(tx, tenantId)
      if (held !== 0) return { ok: false, error: `IFRS 9 cannot be switched off while the ledger holds an allowance of R${(Math.abs(held) / 100).toFixed(2)}: it would never be released` }
    }
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
