/**
 * Pushing a closed batch to Xero as ONE manual journal, at most once.
 *
 * The journal summarises the batch per account (and tax code): the detail
 * stays in CredaFlow, the general ledger gets the month's movement. It is
 * created as a DRAFT so the lender's accountant posts it in Xero.
 *
 * Idempotency is the AccountingXeroPush row: claimed (SENDING) before the
 * request, unique per batch, DB-guarded. PUSHED is final. A definite failure
 * (Xero refused, rate limit exhausted, no valid token) may be claimed again;
 * an unknown outcome is NEEDS_REVIEW until a person checks Xero.
 *
 * Xero does not accept manual journals to bank accounts: map the BANK role to
 * a clearing account (Settings for the export) and reconcile the bank feed
 * against it in Xero.
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { StoredLine } from "../csv"
import { parsePeriodKey } from "../period"
import { loadBatchLines } from "../store"
import { createManualJournal, XeroError, type ManualJournal, type XeroHttp } from "./client"
import { xeroAccessToken } from "./connection"

export type PushDb = Pick<typeof prisma,
  "accountingXeroPush" | "accountingExportBatch" | "accountingJournalLine" | "accountingAccountMapping" | "accountingLedgerEntry"
  | "loan" | "xeroConnection" | "auditLog" | "$transaction" | "$queryRaw">

export type PushOutcome =
  | { ok: true; status: "PUSHED"; manualJournalId: string }
  | { ok: false; httpStatus: number; status: "FAILED" | "NEEDS_REVIEW" | null; error: string }

export function summariseForXero(lines: StoredLine[], narration: string, date: string): ManualJournal {
  const byAccount = new Map<string, { code: string; tax: string | null; net: number }>()
  for (const l of lines) {
    const key = `${l.accountCode}|${l.taxCode ?? ""}`
    const row = byAccount.get(key) ?? { code: l.accountCode, tax: l.taxCode, net: 0 }
    row.net += l.debitCents - l.creditCents
    byAccount.set(key, row)
  }
  const journalLines = [...byAccount.values()]
    .filter((r) => r.net !== 0)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : (a.tax ?? "") < (b.tax ?? "") ? -1 : 1))
    .map((r) => ({
      LineAmount: r.net / 100,
      AccountCode: r.code,
      Description: narration,
      ...(r.tax ? { TaxType: r.tax } : {}),
    }))
  return { Narration: narration, Date: date, Status: "DRAFT", LineAmountTypes: "NoTax", JournalLines: journalLines }
}

async function audit(db: Pick<typeof prisma, "auditLog">, tenantId: string, actor: { id: string; email: string }, batchId: string, action: string, newValue: Record<string, unknown>) {
  await logAuditStrict({ tenantId, userId: actor.id, userEmail: actor.email, action, entity: "AccountingExportBatch", entityId: batchId, newValue }, db)
}

export async function pushBatchToXero(db: PushDb, args: {
  tenantId: string
  batchId: string
  actor: { id: string; email: string }
}, http: XeroHttp = {}): Promise<PushOutcome> {
  const batch = await db.accountingExportBatch.findFirst({ where: { id: args.batchId, tenantId: args.tenantId, status: "CLOSED" }, select: { id: true, periodKey: true } })
  if (!batch) return { ok: false, httpStatus: 404, status: null, error: "Closed batch not found" }
  const lines = await loadBatchLines(db, args.tenantId, batch.id)
  const period = parsePeriodKey(batch.periodKey)
  if (!lines || !period) return { ok: false, httpStatus: 404, status: null, error: "Closed batch not found" }
  const journal = summariseForXero(lines, `CredaFlow journals ${period.label} (batch ${batch.id})`, period.lastDay)
  if (journal.JournalLines.length === 0) return { ok: false, httpStatus: 422, status: null, error: "This month moved no account; there is nothing to push" }
  const connection = await db.xeroConnection.findUnique({ where: { tenantId: args.tenantId }, select: { status: true, xeroTenantId: true } })
  if (connection?.status !== "CONNECTED" || !connection.xeroTenantId) return { ok: false, httpStatus: 409, status: null, error: "Connect Xero and choose an organisation first" }

  // Claim before send.
  const claimedAt = new Date()
  const claimed = await db.$transaction(async (tx) => {
    const existing = await tx.accountingXeroPush.findUnique({ where: { batchId: batch.id }, select: { status: true } })
    if (existing && existing.status !== "FAILED") return existing.status
    try {
      if (existing) {
        const moved = await tx.accountingXeroPush.updateMany({
          where: { batchId: batch.id, tenantId: args.tenantId, status: "FAILED" },
          data: { status: "SENDING", error: null, xeroTenantId: connection.xeroTenantId!, pushedById: args.actor.id },
        })
        if (moved.count !== 1) return "SENDING" as const
      } else {
        await tx.accountingXeroPush.create({ data: { tenantId: args.tenantId, batchId: batch.id, status: "SENDING", xeroTenantId: connection.xeroTenantId!, pushedById: args.actor.id } })
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "SENDING" as const
      throw error
    }
    await audit(tx, args.tenantId, args.actor, batch.id, AuditAction.ACCOUNTING_XERO_PUSH_CLAIMED, { xeroTenantId: connection.xeroTenantId, lines: journal.JournalLines.length })
    return null
  })
  if (claimed) {
    const message = claimed === "PUSHED" ? "This batch is already in Xero" : claimed === "NEEDS_REVIEW" ? "A previous push has an unknown outcome; resolve it first" : "A push of this batch is in progress"
    return { ok: false, httpStatus: 409, status: null, error: message }
  }

  let result: PushOutcome
  try {
    const token = await xeroAccessToken(db, args.tenantId, http)
    const { manualJournalId } = await createManualJournal({
      accessToken: token.accessToken,
      xeroTenantId: token.xeroTenantId,
      journal,
      idempotencyKey: `credaflow-${batch.id}-${claimedAt.getTime()}`,
    }, http)
    result = { ok: true, status: "PUSHED", manualJournalId }
  } catch (error) {
    const xero = error instanceof XeroError ? error : null
    const definite = xero !== null && xero.kind !== "unknown"
    result = { ok: false, httpStatus: 502, status: definite ? "FAILED" : "NEEDS_REVIEW", error: (xero?.message ?? "Xero push failed").slice(0, 500) }
  }
  const status = result.ok ? "PUSHED" : result.status!
  await db.$transaction(async (tx) => {
    await tx.accountingXeroPush.updateMany({
      where: { batchId: batch.id, tenantId: args.tenantId, status: "SENDING" },
      data: result.ok ? { status, xeroManualJournalId: result.manualJournalId } : { status, error: result.error },
    })
    await audit(tx, args.tenantId, args.actor, batch.id, AuditAction.ACCOUNTING_XERO_PUSH_RESULT, result.ok ? { status, manualJournalId: result.manualJournalId } : { status, error: result.error })
  })
  return result
}

/** A person's answer to an unknown outcome, after checking Xero. */
export async function resolveXeroPush(db: PushDb, args: {
  tenantId: string
  batchId: string
  outcome: "pushed" | "not_pushed"
  manualJournalId: string | null
  note: string
  actor: { id: string; email: string }
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const moved = await tx.accountingXeroPush.updateMany({
      where: { batchId: args.batchId, tenantId: args.tenantId, status: "NEEDS_REVIEW" },
      data: args.outcome === "pushed"
        ? { status: "PUSHED", xeroManualJournalId: args.manualJournalId, resolvedById: args.actor.id, resolutionNote: args.note }
        : { status: "FAILED", resolvedById: args.actor.id, resolutionNote: args.note },
    })
    if (moved.count !== 1) return false
    await audit(tx, args.tenantId, args.actor, args.batchId, AuditAction.ACCOUNTING_XERO_PUSH_RESOLVED, { outcome: args.outcome, manualJournalId: args.manualJournalId, note: args.note })
    return true
  })
}
