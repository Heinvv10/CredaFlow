/**
 * Harness for the asset-finance journal break tests (RUN_ACCOUNTING_IT): a fresh lender, asset-finance contracts
 * written through the existing fixture, months closed through the real planner and closePeriod, and an oracle that
 * recomputes balances from the raw tables without any lib/accounting/sources-*.ts. Not a test file.
 */
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { ASSET_FINANCE_ROLES, type AccountRole } from "./accounts"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { AccountingPeriodError, closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod, type PeriodPlan } from "./plan"
import type { SourceLoan } from "./source-types"

export const RUN = process.env.RUN_ACCOUNTING_IT === "1"
export const db = RUN ? new PrismaClient() : (null as unknown as PrismaClient)
export const NOW = new Date("2026-12-05T10:00:00+02:00")

/** Appends `s` to every id a SourceLoan carries (its own, rows, payments, invoices, recoveries ...) so a fixture can be inserted twice. */
export function renamed(loan: SourceLoan, s: string): SourceLoan {
  const walk = (value: unknown, key = ""): unknown => {
    if (value instanceof Date || value === null || typeof value !== "object") {
      return typeof value === "string" && ["id", "proceedsPaymentId", "invoiceId", "sourceId"].includes(key) ? `${value}-${s}` : value
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key))
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]))
  }
  const out = walk(loan) as SourceLoan
  return { ...out, reference: `${loan.reference}-${s}` }
}

export interface Lender { tenant: ChargesTenant; loanIds: string[] }

export async function newLender(loans: SourceLoan[], confirmed = true): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  await removeSourceLoans(db, loans.map((l) => l.id))
  for (const loan of loans) await insertSourceLoan(db, tenant, loan)
  await db.accountingSettings.create({ data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", ...(confirmed ? { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } : {}) } })
  return { tenant, loanIds: loans.map((l) => l.id) }
}

export async function dropLender(l: Lender): Promise<void> {
  await removeSourceLoans(db, l.loanIds)
}

export const planOf = (t: ChargesTenant, key: string, now = NOW): Promise<PeriodPlan> =>
  runWithTenant(t.tenantId, () => planPeriod(prisma, t.tenantId, parsePeriodKey(key)!, now))

export const closeOf = (t: ChargesTenant, key: string, now = NOW) =>
  runWithTenant(t.tenantId, () => closePeriod(prisma, { tenantId: t.tenantId, periodKey: key, userId: t.userId, userEmail: "af-break@test.invalid", now }))

export interface MonthOutcome { key: string; code: string | null; message: string | null; closed: boolean; entries: number; controls: number; mismatches: number }

/** Closes each month in turn as the lender would; stops at the first refusal. */
export async function closeMonths(t: ChargesTenant, keys: string[], now = NOW): Promise<MonthOutcome[]> {
  const out: MonthOutcome[] = []
  for (const key of keys) {
    const plan = await planOf(t, key, now)
    try {
      await closeOf(t, key, now)
      out.push({ key, code: null, message: null, closed: true, entries: plan.entries.length, controls: plan.controls.length, mismatches: plan.reconciliation.mismatches.length })
    } catch (error) {
      if (!(error instanceof AccountingPeriodError)) throw error
      out.push({ key, code: error.code, message: error.message, closed: false, entries: plan.entries.length, controls: plan.controls.length, mismatches: plan.reconciliation.mismatches.length })
      break
    }
  }
  return out
}

/** Σ(debit - credit) per role over every closed batch of the tenant. */
export async function ledgerTotals(tenantId: string): Promise<Partial<Record<AccountRole, number>>> {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${tenantId} AND b."status" = 'CLOSED' AND l."role" <> 'OPENING_BALANCE_EQUITY' GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)]))
}

/** Per-role ledger of one contract's sources (by loan id on the entry). */
export async function ledgerOfLoan(tenantId: string, loanId: string): Promise<Partial<Record<AccountRole, number>>> {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingLedgerEntry" e ON e."id" = l."entryId" JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${tenantId} AND b."status" = 'CLOSED' AND e."loanId" = ${loanId} GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)]))
}

/**
 * BANK the lender's own tables imply at `asOf` (SAST midnight instant), never through the sources: the supplier payouts out,
 * receipts in (not waivers, not a recovery's proceeds receipt: that cash came with the sale), sale prices in, released refunds out,
 * maintenance claims out. `reconciledAt`/status handling follows the payments table as written.
 */
export async function expectedBank(tenantId: string, asOf: Date, from = new Date("2026-07-31T22:00:00Z")): Promise<number> {
  const [r] = await db.$queryRaw<Array<{ cents: bigint }>>`
    SELECT (
      - COALESCE((SELECT SUM(p."amountCents") FROM "Payout" p WHERE p."tenantId" = ${tenantId} AND p."status" = 'RELEASED' AND p."releasedAt" >= ${from} AND p."releasedAt" < ${asOf}), 0)
      + COALESCE((SELECT SUM(pay."amount") FROM "Payment" pay JOIN "Loan" ln ON ln."id" = pay."loanId"
          WHERE pay."tenantId" = ${tenantId} AND ln."contractType" <> 'LOAN' AND pay."receivedAt" >= ${from} AND pay."receivedAt" < ${asOf} AND pay."paymentMethod" <> 'WAIVER'
            AND NOT COALESCE(pay."reversed" AND pay."reversedAt" < ${asOf}, false)
            AND NOT (pay."allocationStatus" = 'REFUNDED' AND pay."reconciledAt" < ${asOf})
            AND NOT EXISTS (SELECT 1 FROM "Recovery" r WHERE r."proceedsPaymentId" = pay."id")), 0)
      + COALESCE((SELECT SUM(rs."priceInclVatCents") FROM "RemarketingSale" rs JOIN "TaxInvoice" i ON i."id" = rs."taxInvoiceId"
          WHERE rs."tenantId" = ${tenantId} AND rs."status" = 'COMPLETED' AND (i."issueDate"::timestamp - interval '2 hours') >= ${from} AND (i."issueDate"::timestamp - interval '2 hours') < ${asOf}), 0)
      - COALESCE((SELECT SUM(m."amountCents") FROM "MaintenanceFundMovement" m JOIN "MaintenanceFund" f ON f."id" = m."fundId"
          WHERE m."tenantId" = ${tenantId} AND (m."occurredOn"::timestamp - interval '2 hours') >= ${from} AND (m."occurredOn"::timestamp - interval '2 hours') < ${asOf}
            AND ((f."riskModel" = 'LENDER_RISK' AND m."kind" = 'CLAIM') OR (f."riskModel" = 'LESSEE_SETTLED' AND m."kind" IN ('CLAIM', 'SETTLEMENT_REFUND')))), 0)
      - COALESCE((SELECT SUM(f."amountCents") FROM "RecoveryRefund" f WHERE f."tenantId" = ${tenantId} AND f."status" = 'RELEASED' AND f."releasedAt" >= ${from} AND f."releasedAt" < ${asOf}), 0)
    )::bigint AS cents`
  return Number(r.cents)
}

/** An instalment sale of IS-1's shape that is then repossessed: `recoveryDeal`'s recovery, payments and charges on IS-1's contract. */
export function repossessedLoan(base: SourceLoan, recoveryDeal: SourceLoan, s: string): SourceLoan {
  const id = (x: string) => `${x}-${s}`
  const rec = structuredClone(recoveryDeal.assetFinance!.recoveries[0])
  const sale = rec.sale && { ...rec.sale, id: id(rec.sale.id), invoice: { ...rec.sale.invoice, id: id(rec.sale.invoice.id) } }
  const recovery = {
    ...rec, id: id(rec.id), proceedsPaymentId: rec.proceedsPaymentId && id(rec.proceedsPaymentId), sale,
    costs: rec.costs.map((c) => ({ ...c, id: id(c.id) })), vatEvents: rec.vatEvents.map((e) => ({ ...e, id: id(e.id) })),
    refund: rec.refund && { ...rec.refund, id: id(rec.refund.id) },
  }
  const af = base.assetFinance!
  return {
    ...base, id: id(base.id), reference: `${base.reference}-${s}`, payments: recoveryDeal.payments.map((p) => ({ ...p, id: id(p.id) })),
    charges: recoveryDeal.charges.map((c) => ({ ...c, sourceId: c.sourceId && id(c.sourceId) })),
    schedule: base.schedule.map((r) => ({ ...r, id: id(r.id) })),
    assetFinance: { ...af, inceptionInvoice: af.inceptionInvoice && { ...af.inceptionInvoice, id: id(af.inceptionInvoice.id) }, recoveries: [recovery] },
  }
}

// ---- routes as a staff session (RUN_ACCOUNTING_IT) ----
import { NextRequest } from "next/server"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
export const sessionBox = { current: null as null | { user: SessionUser } }

/** Gives the lender a host, switches staff 2FA off for it, and returns the host. */
export async function withHost(t: ChargesTenant): Promise<string> {
  const host = `af-break-${t.tenantId.slice(-10)}.break-it.test`
  await db.tenant.update({ where: { id: t.tenantId }, data: { domain: host } })
  await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { requireStaffTotp: false } })
  return host
}

export const asStaff = (t: ChargesTenant, role: "ADMIN" | "LOAN_ADMIN" | "CREDIT_OFFICER", id = t.userId) => {
  sessionBox.current = { user: { id, email: `${id}@break-it.test`, role, tenantId: t.tenantId } as SessionUser }
}

export function call(host: string, path: string, method: "GET" | "POST" | "PUT" = "GET", body?: unknown) {
  return new NextRequest(`http://${host}${path}`, { method, headers: { host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
export const json = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> })
