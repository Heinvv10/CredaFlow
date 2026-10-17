/**
 * Real-Postgres helpers for the lease-servicing suites (slice 3, C5–C8): the
 * staff and portal lease routes called through the real handlers, a booked
 * lease moved back in time so its rentals have fallen due (test setup only,
 * triggers off), a document filed on a deal, and paying a lease in full
 * through the real receipt path. Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import type { LeaseFixture } from "./lease.integration-fixture"
import { POST as claimsRoute } from "@/app/api/asset-finance/leases/[loanId]/claims/route"
import { POST as claimActionRoute } from "@/app/api/asset-finance/leases/[loanId]/claims/[claimId]/[action]/route"
import { POST as readingsRoute } from "@/app/api/asset-finance/leases/[loanId]/readings/route"
import { POST as endOfTermRoute } from "@/app/api/asset-finance/leases/[loanId]/end-of-term/[action]/route"
import { POST as quoteRoute } from "@/app/api/asset-finance/leases/[loanId]/termination-quotes/route"
import { POST as acceptRoute } from "@/app/api/asset-finance/leases/[loanId]/termination-quotes/[quoteId]/accept/route"
import { POST as portalReadingsRoute } from "@/app/api/portal/asset-finance/leases/[loanId]/readings/route"
import { POST as portalQuoteRoute } from "@/app/api/portal/asset-finance/leases/[loanId]/termination-quotes/route"
import { POST as portalAcceptRoute } from "@/app/api/portal/asset-finance/leases/[loanId]/termination-quotes/[quoteId]/accept/route"
import { POST as portalEndOfTermRoute } from "@/app/api/portal/asset-finance/leases/[loanId]/end-of-term/route"

export function leaseRoutes(host: string) {
  const req = (path: string, body: unknown = {}) => new NextRequest(`http://${host}${path}`, {
    method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const base = (loanId: string) => `/api/asset-finance/leases/${loanId}`
  const portal = (loanId: string) => `/api/portal/asset-finance/leases/${loanId}`
  return {
    claim: (loanId: string, body: unknown) => claimsRoute(req(`${base(loanId)}/claims`, body), { params: Promise.resolve({ loanId }) }),
    claimAction: (loanId: string, claimId: string, action: string, body: unknown = {}) =>
      claimActionRoute(req(`${base(loanId)}/claims/${claimId}/${action}`, body), { params: Promise.resolve({ loanId, claimId, action }) }),
    reading: (loanId: string, body: unknown) => readingsRoute(req(`${base(loanId)}/readings`, body), { params: Promise.resolve({ loanId }) }),
    endOfTerm: (loanId: string, action: string, body: unknown = {}) =>
      endOfTermRoute(req(`${base(loanId)}/end-of-term/${action}`, body), { params: Promise.resolve({ loanId, action }) }),
    quote: (loanId: string) => quoteRoute(req(`${base(loanId)}/termination-quotes`), { params: Promise.resolve({ loanId }) }),
    accept: (loanId: string, quoteId: string) => acceptRoute(req(`${base(loanId)}/termination-quotes/${quoteId}/accept`), { params: Promise.resolve({ loanId, quoteId }) }),
    portalReading: (loanId: string, body: unknown) => portalReadingsRoute(req(`${portal(loanId)}/readings`, body), { params: Promise.resolve({ loanId }) }),
    portalQuote: (loanId: string) => portalQuoteRoute(req(`${portal(loanId)}/termination-quotes`), { params: Promise.resolve({ loanId }) }),
    portalAccept: (loanId: string, quoteId: string) =>
      portalAcceptRoute(req(`${portal(loanId)}/termination-quotes/${quoteId}/accept`), { params: Promise.resolve({ loanId, quoteId }) }),
    portalEndOfTerm: (loanId: string, body: unknown) => portalEndOfTermRoute(req(`${portal(loanId)}/end-of-term`, body), { params: Promise.resolve({ loanId }) }),
  }
}

/** Test setup only (triggers off): move a booked lease's dates, readings and fund `months` back. */
export async function backdateLease(db: PrismaClient, loanId: string, months: number): Promise<void> {
  await shiftLease(db, loanId, `${months} months`)
}

/**
 * Test setup only (triggers off): move a booked lease's dates, readings, fund,
 * rental invoices and end-of-term dates back by `interval` (a Postgres
 * interval; negative moves them forward).
 */
export async function shiftLease(db: PrismaClient, loanId: string, interval: string): Promise<void> {
  const i = `INTERVAL '${interval}'`
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.$executeRawUnsafe(`UPDATE "Loan" SET "startDate" = ((("startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date - ${i}) AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'UTC', "maturityDate" = ((("maturityDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date - ${i}) AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'UTC', "nextPaymentDate" = ((("nextPaymentDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date - ${i}) AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'UTC' WHERE "id" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "dueDate" = ((("dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date - ${i}) AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'UTC' WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "LeaseRental" SET "dueDate" = ("dueDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "TaxInvoice" SET "issueDate" = ("issueDate" - ${i})::date, "supplyDate" = ("supplyDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "AssetMeterReading" SET "readingDate" = ("readingDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "MaintenanceFund" SET "leaseEndDate" = ("leaseEndDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "ContractRate" SET "effectiveDate" = ("effectiveDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    db.$executeRawUnsafe(`UPDATE "LeaseEndOfTerm" SET "electedAt" = "electedAt" - ${i}, "extensionNoticeOn" = ("extensionNoticeOn" - ${i})::date,
      "extensionEndsOn" = ("extensionEndsOn" - ${i})::date, "inspectedOn" = ("inspectedOn" - ${i})::date WHERE "loanId" = $1`, loanId),
  ])
}

/** A staff-uploaded document filed on the lease's deal. */
export async function leaseDocument(db: PrismaClient, fx: LeaseFixture, loanId: string, docType: "SUPPLIER_INVOICE" | "OTHER" = "SUPPLIER_INVOICE"): Promise<string> {
  const deal = await db.assetFinanceDeal.findFirstOrThrow({ where: { loanId }, select: { id: true, entityId: true, clientId: true } })
  return (await db.entityDocument.create({
    data: {
      tenantId: fx.tenantId, entityId: deal.entityId, clientId: deal.entityId ? null : deal.clientId, dealId: deal.id, docType,
      fileName: `${docType.toLowerCase()}.pdf`, mimeType: "application/pdf", fileSize: 1, storagePath: `/nonexistent/${deal.id}-${randomUUID()}.pdf`,
      contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
    },
  })).id
}

/** Pays everything the lease owes now through the real manual-receipt path. Returns the amount. */
export async function payAllOwed(db: PrismaClient, fx: LeaseFixture, loanId: string): Promise<number> {
  const rows = await db.repaymentSchedule.findMany({ where: { loanId } })
  const owed = rows.reduce((sum, r) => sum + Math.max(0, r.totalDue - r.totalPaid), 0)
  if (owed > 0) await applyManualReceipt(db as unknown as PaymentDb, { loanId, tenantId: fx.tenantId, amount: owed, capturedById: fx.officer, reference: `SYNTHETIC-${randomUUID().slice(0, 8)}` })
  return owed
}

/** Test setup only (triggers off): raw statements, each `[sql, ...params]`, in one transaction. */
export async function testSetup(db: PrismaClient, ...statements: [string, ...unknown[]][]): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    ...statements.map(([sql, ...params]) => db.$executeRawUnsafe(sql, ...params)),
  ])
}

/**
 * A database rule: a trigger (disabled), a CHECK constraint or unique index
 * (dropped), or ONE clause of a trigger function (`replace: [clause, with]`:
 * the function is redefined with that exact clause, which must occur once,
 * replaced) — only inside a rolled-back transaction.
 */
export type DbRule = { table: string; trigger: string } | { table: string; constraint: string } | { index: string } | { fn: string; replace: readonly [string, string] }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
class RolledBack extends Error {}

async function ruleOff(tx: Tx, rule: DbRule): Promise<void> {
  if ("fn" in rule) {
    const [row] = await tx.$queryRawUnsafe<{ def: string }[]>(`SELECT pg_get_functiondef('public."${rule.fn}"'::regproc) AS def`)
    const [clause, replacement] = rule.replace
    const found = row.def.split(clause).length - 1
    if (found !== 1) throw new Error(`${rule.fn}: the clause must occur exactly once, found ${found}: ${clause}`)
    await tx.$executeRawUnsafe(row.def.replace(clause, () => replacement))
    return
  }
  if ("trigger" in rule) await tx.$executeRawUnsafe(`ALTER TABLE "${rule.table}" DISABLE TRIGGER "${rule.trigger}"`)
  else if ("constraint" in rule) await tx.$executeRawUnsafe(`ALTER TABLE "${rule.table}" DROP CONSTRAINT "${rule.constraint}"`)
  else await tx.$executeRawUnsafe(`DROP INDEX "${rule.index}"`)
}

/**
 * Runs `attack` in a transaction that is always rolled back, deferred checks
 * fired first; with `without`, that rule is removed inside it. Returns "ok"
 * or the refusal's message.
 */
export async function attempt(db: PrismaClient, attack: (tx: Tx) => Promise<unknown>, without?: DbRule): Promise<string> {
  try {
    await db.$transaction(async (tx) => {
      if (without) await ruleOff(tx, without)
      await attack(tx)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      throw new RolledBack()
    }, { timeout: 30_000 })
  } catch (error) {
    if (error instanceof RolledBack) return "ok"
    if (!(error instanceof Error)) return String(error)
    const meta = JSON.stringify(error, Object.getOwnPropertyNames(error).filter((k) => k !== "stack"))
    return `${error.name}: ${error.message} ${meta}`
  }
  return "ok"
}

/** The rule refuses the attack, and is what refuses it: without it, the attack goes through. */
export async function ruleRefuses(db: PrismaClient, rule: DbRule, message: RegExp, attack: (tx: Tx) => Promise<unknown>): Promise<void> {
  const refused = await attempt(db, attack)
  if (!message.test(refused)) throw new Error(`expected a refusal matching ${message}, got: ${refused}`)
  const without = await attempt(db, attack, rule)
  if (without !== "ok") throw new Error(`without ${JSON.stringify(rule)} the attack should go through, got: ${without}`)
}

/** The attack goes through as it is: the control for a boundary a rule must admit. */
export async function ruleAdmits(db: PrismaClient, attack: (tx: Tx) => Promise<unknown>): Promise<void> {
  const result = await attempt(db, attack)
  if (result !== "ok") throw new Error(`expected the database to admit it, got: ${result}`)
}
