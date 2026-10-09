import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { chargesEnabled, loadChargesReplay } from "@/lib/loan/charges-replay"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { OVERPAYMENT_REASON } from "@/lib/loan/receipt-rules"
import type { ChargesOwingByBand } from "@/lib/reports/charges-owing"
import {
  defaultChargesByMonth,
  sastMonthKey,
  type DefaultChargesMonth,
  type DefaultChargesRow,
} from "@/lib/reports/default-charges"

// Queries behind the Default charges report and the board-pack summary line.
// Read-only, tenant-scoped on every query. ALL money is CENTS.

type Db = Pick<
  typeof prisma,
  "tenantConfig" | "loanProduct" | "loanCharge" | "payment" | "auditLog" | "loan" | "repaymentSchedule" | "complianceRecord"
>

export type ChargesState = "never" | "live" | "stopped"

export interface RefundDueRow {
  paymentId: string
  loanId: string
  loanReference: string
  clientName: string
  amount: number
  receivedAt: Date
  /** when the refund became due: the exemption for a charges refund, else the receipt */
  dueSince: Date
  source: "exemption" | "over-payment"
}

export interface DefaultChargesReport {
  state: ChargesState
  startedAt: Date | null
  stoppedAt: Date | null
  rows: DefaultChargesRow[]
  months: DefaultChargesMonth[]
  refundsDue: RefundDueRow[]
}

const json = (value: Prisma.JsonValue | null): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}

export interface RefundSplitAudit {
  at: Date
  loanId: string | null
  cents: number
  refundPaymentId: string | null
}

/** A PAYMENT_REFUND_DUE_SPLIT row, as lib/loan/refund-excess.ts writes it. */
export function parseRefundSplitAudit(row: { createdAt: Date; newValue: Prisma.JsonValue | null }): RefundSplitAudit {
  const v = json(row.newValue)
  return {
    at: row.createdAt,
    loanId: typeof v.loanId === "string" ? v.loanId : null,
    cents: typeof v.refundDueCents === "number" ? v.refundDueCents : 0,
    refundPaymentId: typeof v.refundPaymentId === "string" ? v.refundPaymentId : null,
  }
}

/** A DEFAULT_CHARGES_EXEMPTION_CHANGED row: whether the loan was exempt before and after. */
export function parseExemptionAudit(row: { oldValue: Prisma.JsonValue | null; newValue: Prisma.JsonValue | null }) {
  return {
    from: json(row.oldValue).defaultChargesExempt === true,
    to: json(row.newValue).defaultChargesExempt === true,
  }
}

/**
 * Unrefunded refund-due receipts, each labelled by where it came from: a
 * charges exemption (a PAYMENT_REFUND_DUE_SPLIT audit names it, and dates when
 * it became due) or a receipt beyond what the loan owed (due since received).
 */
export function refundDueRows(
  payments: Array<{
    id: string; amount: number; receivedAt: Date; loanId: string
    loan: { reference: string; client: { firstName: string; lastName: string } }
  }>,
  splits: RefundSplitAudit[],
): RefundDueRow[] {
  const exemptionAt = new Map(splits.flatMap((s) => (s.refundPaymentId ? [[s.refundPaymentId, s.at] as const] : [])))
  return payments.map((p) => {
    const at = exemptionAt.get(p.id)
    return {
      paymentId: p.id,
      loanId: p.loanId,
      loanReference: p.loan.reference,
      clientName: `${p.loan.client.firstName} ${p.loan.client.lastName}`,
      amount: p.amount,
      receivedAt: p.receivedAt,
      dueSince: at ?? p.receivedAt,
      source: at ? "exemption" : "over-payment",
    }
  })
}

export async function loadDefaultChargesReport(db: Db, tenantId: string, now: Date): Promise<DefaultChargesReport> {
  const [config, products, charges, receipts, exemptionAudits, refundAudits, refundRows] = await Promise.all([
    db.tenantConfig.findUnique({
      where: { tenantId },
      select: { defaultChargesEnabled: true, defaultChargesStartedAt: true, defaultChargesStoppedAt: true },
    }),
    db.loanProduct.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    db.loanCharge.findMany({
      where: { tenantId },
      select: { type: true, day: true, amount: true, loan: { select: { productId: true } } },
    }),
    db.payment.findMany({
      where: { tenantId, OR: [{ defaultInterestAllocated: { gt: 0 } }, { chargeFeesAllocated: { gt: 0 } }] },
      select: {
        receivedAt: true, paymentMethod: true, reversed: true, allocationStatus: true,
        defaultInterestAllocated: true, chargeFeesAllocated: true, loan: { select: { productId: true } },
      },
    }),
    db.auditLog.findMany({
      where: { tenantId, action: AuditAction.DEFAULT_CHARGES_EXEMPTION_CHANGED, entity: "Loan" },
      select: { entityId: true, createdAt: true, oldValue: true, newValue: true },
    }),
    db.auditLog.findMany({
      where: { tenantId, action: AuditAction.PAYMENT_REFUND_DUE_SPLIT },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, newValue: true },
    }),
    db.payment.findMany({
      where: { tenantId, allocationStatus: "UNAPPLIED", reconciliationReason: OVERPAYMENT_REASON, reversed: false },
      orderBy: { receivedAt: "asc" },
      select: {
        id: true, amount: true, receivedAt: true, loanId: true,
        loan: { select: { reference: true, client: { select: { firstName: true, lastName: true } } } },
      },
    }),
  ])

  const refunds = refundAudits.map(parseRefundSplitAudit)
  const auditLoanIds = [...new Set([
    ...exemptionAudits.map((a) => a.entityId),
    ...refunds.map((r) => r.loanId),
  ].filter((id): id is string => id !== null))]
  const auditLoans = auditLoanIds.length === 0 ? [] : await db.loan.findMany({
    where: { tenantId, id: { in: auditLoanIds } },
    select: { id: true, productId: true },
  })
  const productOf = new Map(auditLoans.map((l) => [l.id, l.productId]))

  const { rows, months } = defaultChargesByMonth({
    products: new Map(products.map((p) => [p.id, p.name])),
    now,
    stoppedAt: config?.defaultChargesStoppedAt ?? null,
    charges: charges.map((c) => ({ productId: c.loan.productId, type: c.type, day: c.day, amount: c.amount })),
    receipts: receipts.map(({ loan, ...r }) => ({ ...r, productId: loan.productId })),
    exemptions: exemptionAudits.flatMap((a) => {
      const productId = a.entityId ? productOf.get(a.entityId) : undefined
      if (!productId) return []
      return [{ productId, at: a.createdAt, ...parseExemptionAudit(a) }]
    }),
    refunds: refunds.flatMap((r) => {
      const productId = r.loanId ? productOf.get(r.loanId) : undefined
      return productId ? [{ productId, at: r.at, cents: r.cents }] : []
    }),
  })

  const state: ChargesState = config?.defaultChargesStoppedAt
    ? "stopped"
    : chargesEnabled({ tenant: { config } }) ? "live" : "never"
  return {
    state,
    startedAt: config?.defaultChargesStartedAt ?? null,
    stoppedAt: config?.defaultChargesStoppedAt ?? null,
    rows,
    months,
    refundsDue: refundDueRows(refundRows, refunds),
  }
}

export interface BoardPackChargesSummary {
  /** this SAST month */
  accrued: number
  collected: number
  /** owing now on the collectible book: in the DPD bands, and on loans with no instalment arrears */
  owingInBands: number
  owingNotInArrears: number
  /** owing now on written-off and closed loans (SETTLED_STATUSES) */
  owingElsewhere: number
  /** unrefunded money owed back because an exemption removed charges already paid */
  exemptionRefunds: { count: number; amount: number }
}

/**
 * The board-pack line. Null unless charges are live. `owing` is the board
 * pack's own collectible-book figure, so the line ties to its DPD bands;
 * `owingSettled` is read directly from the written-off and closed loans, never
 * derived as a difference, so a read racing a receipt cannot invent money there.
 */
export function boardPackChargesSummary(
  report: DefaultChargesReport,
  owing: ChargesOwingByBand,
  owingSettled: number,
  now: Date,
): BoardPackChargesSummary | null {
  if (report.state !== "live") return null
  const month = report.months.find((m) => m.month === sastMonthKey(now))
  const exemption = report.refundsDue.filter((r) => r.source === "exemption")
  return {
    accrued: month?.accrued ?? 0,
    collected: month?.collected ?? 0,
    owingInBands: owing.total - owing.notInArrears.amount,
    owingNotInArrears: owing.notInArrears.amount,
    owingElsewhere: owingSettled,
    exemptionRefunds: { count: exemption.length, amount: exemption.reduce((sum, r) => sum + r.amount, 0) },
  }
}

export interface InDuplumRow {
  loanId: string
  loanReference: string
  clientName: string
  productName: string
  capBase: number
  accrued: number
}

/**
 * Loans whose current default has reached the in duplum cap (s103(5)): a
 * read-only replay of each loan in the collectible book that owes charges or
 * is overdue. Empty unless charges are live (the replay returns null then).
 */
export async function loadInDuplumSnapshot(db: Db, tenantId: string, now: Date): Promise<InDuplumRow[]> {
  const loans = await db.loan.findMany({
    where: {
      tenantId,
      status: { in: [...COLLECTIBLE_STATUSES] },
      OR: [{ chargesOutstanding: { gt: 0 } }, { daysInArrears: { gt: 0 } }],
    },
    select: {
      id: true, reference: true,
      client: { select: { firstName: true, lastName: true } },
      product: { select: { name: true } },
    },
    orderBy: { reference: "asc" },
  })
  const rows: InDuplumRow[] = []
  for (const loan of loans) {
    const replay = await loadChargesReplay(db, { tenantId, loanId: loan.id }, now)
    const inDuplum = replay?.result.inDuplum
    if (!inDuplum?.reached) continue
    rows.push({
      loanId: loan.id,
      loanReference: loan.reference,
      clientName: `${loan.client.firstName} ${loan.client.lastName}`,
      productName: loan.product.name,
      capBase: inDuplum.capBase,
      accrued: inDuplum.accrued,
    })
  }
  return rows
}
