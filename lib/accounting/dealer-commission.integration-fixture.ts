/**
 * Real-Postgres fixture for the dealer commission journal suite
 * (RUN_ACCOUNTING_IT): three instalment sales of JRN-IS-1's shape and the
 * commission lines and payable runs the dealer portal leaves on them, written
 * with triggers off (the accrual, clawback and run rules have their own
 * RUN_ASSET_FINANCE_DEALER_IT suites; this one proves the loader, the ledger
 * and the payable control agree on whatever those leave in the tables). The
 * CHECKs still run. Every value is synthetic. Not a test file.
 *
 *   X  dealer A (VAT vendor): earned 2026-08-10, paid by run R1 (released 2026-09-05),
 *      written off 2026-10-20 inside the window: clawed back that day, netted in R3
 *   Z  dealer B (not a vendor): earned 2026-09-12; R2 held it and was cancelled (link voided): unpaid
 *   Y  dealer A: earned 2026-11-03, paid by R3 (released 2026-12-02) net of X's clawback
 */
import type { PrismaClient } from "@prisma/client"
import { day, INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import type { ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { dbDay } from "./asset-finance.integration-fixture"
import type { SourceLoan } from "./source-types"

const IS_1 = INSTALMENT_JOURNAL_DEALS[0].loan

/** JRN-IS-1 with every id suffixed, so it does not collide with the other suites' rows. */
function copyOf(s: string, over: Partial<SourceLoan> = {}): SourceLoan {
  const id = (x: string) => `${x}-${s}`
  const af = IS_1.assetFinance!
  return {
    ...IS_1, id: id(IS_1.id), reference: `${IS_1.reference}-${s.toUpperCase()}`,
    schedule: IS_1.schedule.map((r) => ({ ...r, id: id(r.id) })), payments: IS_1.payments.map((p) => ({ ...p, id: id(p.id) })),
    assetFinance: { ...af, inceptionInvoice: af.inceptionInvoice && { ...af.inceptionInvoice, id: id(af.inceptionInvoice.id) } },
    ...over,
  }
}

export const LOAN_X = copyOf("dcx", { status: "WRITTEN_OFF", writeOffAt: new Date("2026-10-20T10:00:00+02:00") })
export const LOAN_Y = copyOf("dcy")
export const LOAN_Z = copyOf("dcz")
export const COMMISSION_LOANS = [LOAN_X, LOAN_Y, LOAN_Z]

export const DEALER_A = "dlr-it-dc-a"
export const DEALER_B = "dlr-it-dc-b"

interface Line { id: string; loan: SourceLoan; dealerId: string; reverses?: string; on: string; base: number; bps: number; flat: number; net: number; vat: number; vendor: boolean }

export const LINES: Line[] = [
  // 1 000 000 × 250 bps + 150 000 = 175 000; VAT 15 % 26 250
  { id: "dcl-it-x1", loan: LOAN_X, dealerId: DEALER_A, on: "2026-08-10", base: 1_000_000, bps: 250, flat: 150_000, net: 175_000, vat: 26_250, vendor: true },
  { id: "dcl-it-x2", loan: LOAN_X, dealerId: DEALER_A, reverses: "dcl-it-x1", on: "2026-10-20", base: -1_000_000, bps: 250, flat: -150_000, net: -175_000, vat: -26_250, vendor: true },
  // 2 000 000 × 400 bps = 80 000; no VAT
  { id: "dcl-it-z1", loan: LOAN_Z, dealerId: DEALER_B, on: "2026-09-12", base: 2_000_000, bps: 400, flat: 0, net: 80_000, vat: 0, vendor: false },
  // 12 000 000 × 250 bps = 300 000; VAT 45 000
  { id: "dcl-it-y1", loan: LOAN_Y, dealerId: DEALER_A, on: "2026-11-03", base: 12_000_000, bps: 250, flat: 0, net: 300_000, vat: 45_000, vendor: true },
]

interface Run { id: string; dealerId: string; periodEnd: string; status: "RELEASED" | "CANCELLED"; at: string; lines: string[] }

export const RUNS: Run[] = [
  { id: "dpr-it-1", dealerId: DEALER_A, periodEnd: "2026-08-31", status: "RELEASED", at: "2026-09-05T11:00:00+02:00", lines: ["dcl-it-x1"] },
  { id: "dpr-it-2", dealerId: DEALER_B, periodEnd: "2026-09-30", status: "CANCELLED", at: "2026-10-02T09:00:00+02:00", lines: ["dcl-it-z1"] },
  { id: "dpr-it-3", dealerId: DEALER_A, periodEnd: "2026-11-30", status: "RELEASED", at: "2026-12-02T09:00:00+02:00", lines: ["dcl-it-x2", "dcl-it-y1"] },
]

const replica = (db: PrismaClient) => db.$executeRawUnsafe("SET LOCAL session_replication_role = replica")

/** Writes the lines, runs and links (triggers off). The loans must exist (insertSourceLoan). */
export async function insertDealerCommission(db: PrismaClient, t: ChargesTenant): Promise<void> {
  const byId = new Map(LINES.map((l) => [l.id, l]))
  const sum = (ids: string[], pick: (l: Line) => number) => ids.reduce((s, id) => s + pick(byId.get(id)!), 0)
  await db.$transaction([
    replica(db),
    ...LINES.map((l) => db.dealerCommissionLine.create({ data: {
      id: l.id, tenantId: t.tenantId, dealerId: l.dealerId, dealId: `deal-${l.loan.id}`, loanId: l.loan.id, kind: l.reverses ? "REVERSED" : "EARNED",
      reversesLineId: l.reverses ?? null, reason: l.reverses ? "LOAN_WRITTEN_OFF" : null, effectiveOn: dbDay(day(l.on)),
      baseCents: l.base, bps: l.bps, flatCents: l.flat, netCents: l.net, vatRate: 0.15, vatCents: l.vat, grossCents: l.net + l.vat, dealerVatVendor: l.vendor, clawbackMonths: 12,
    } })),
    ...RUNS.map((r) => db.dealerPayableRun.create({ data: {
      id: r.id, tenantId: t.tenantId, dealerId: r.dealerId, periodEnd: dbDay(day(r.periodEnd)), bankAccountId: `dba-it-${r.dealerId}`, status: r.status,
      totalNetCents: sum(r.lines, (l) => l.net), totalVatCents: sum(r.lines, (l) => l.vat), totalGrossCents: sum(r.lines, (l) => l.net + l.vat), createdById: t.userId,
      ...(r.status === "RELEASED"
        ? {
            approvedById: "approver-it", approvedAt: new Date(r.at), releasedById: "releaser-it", releasedAt: new Date(r.at), releaseReference: `EFT-${r.id}`,
            // A run with VAT is released with the dealer's tax invoice (DealerPayableRun_tax_invoice_on_vat).
            ...(sum(r.lines, (l) => l.vat) !== 0 ? { dealerTaxInvoiceReference: `INV-${r.id}`, dealerTaxInvoiceDate: dbDay(day(r.periodEnd)) } : {}),
          }
        : { cancelledById: t.userId, cancelledAt: new Date(r.at) }),
    } })),
    ...RUNS.flatMap((r) => r.lines.map((lineId) => db.dealerPayableRunLine.create({ data: { tenantId: t.tenantId, runId: r.id, lineId, voided: r.status === "CANCELLED" } }))),
  ])
}

/** Removes what insertDealerCommission wrote (triggers off: the guards refuse a DELETE), also left over by an earlier failed run. */
export async function removeDealerCommission(db: PrismaClient): Promise<void> {
  await db.$transaction([
    replica(db),
    db.dealerPayableRunLine.deleteMany({ where: { runId: { in: RUNS.map((r) => r.id) } } }),
    db.dealerPayableRun.deleteMany({ where: { id: { in: RUNS.map((r) => r.id) } } }),
    db.dealerCommissionLine.deleteMany({ where: { id: { in: LINES.map((l) => l.id) } } }),
  ])
}
