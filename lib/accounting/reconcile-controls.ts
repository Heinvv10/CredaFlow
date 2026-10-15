/**
 * Asset-finance controls beyond the receivable tie-out (lib/accounting/
 * reconcile.ts, reconcile-asset-finance.ts). Each compares what the journal
 * holds (the ledger so far plus this period's entries) with a figure computed
 * in SQL from the contract tables, never through lib/accounting/sources-*.ts.
 * A control that differs refuses the close (AF_CONTROL_FAILED). Signs are the
 * journal's: debit +, credit -.
 *
 *   AF_OUTPUT_VAT              per contract: the VAT on its tax invoices (and the buyer invoices of its
 *                              recoveries) less credit notes; the journal holds it as OUTPUT_VAT credits
 *   AF_INPUT_VAT               per contract: the VAT on the dealer's invoice (the lease asset's VAT), on
 *                              approved recovery costs and the repossession input-tax claims
 *   RECOVERY_CLEARING          per recovery: nil once its proceeds are applied or it is withdrawn
 *   RECOVERY_RESULT            per recovery: what the clearing held when it was resolved
 *   RECOVERY_REFUND_PAYABLE    per recovery: the surplus less the refund released
 *   MAINTENANCE_FUND_LIABILITY per fund: a lessee-settled fund's balance; nil for a lender-risk fund
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import type { AccountRole } from "./accounts"
import type { DerivedEntry, PostedLedger } from "./derive"
import type { Vector } from "./source-types"

export interface ControlMismatch {
  control: string
  key: string
  journalCents: number
  bookCents: number
}

/** The journal per source: the ledger so far plus this period's entries (the opening entry is presentation only). */
export function journalByKey(
  posted: PostedLedger,
  postedLoans: Map<string, { loanId: string | null; reference: string }>,
  entries: DerivedEntry[],
): Map<string, { loanId: string | null; vector: Vector }> {
  const out = new Map<string, { loanId: string | null; vector: Vector }>()
  for (const [baseKey, vector] of posted) out.set(baseKey, { loanId: postedLoans.get(baseKey)?.loanId ?? null, vector: { ...vector } })
  for (const e of entries) {
    if (e.eventType === "OPENING") continue
    const entry = out.get(e.baseKey) ?? { loanId: e.loanId, vector: {} }
    for (const l of e.lines) {
      const role = l.sourceRole ?? l.role
      entry.vector[role] = (entry.vector[role] ?? 0) + l.debitCents - l.creditCents
    }
    out.set(e.baseKey, entry)
  }
  return out
}

type Db = Pick<typeof prisma, "$queryRaw">
const sast = (column: string) => Prisma.raw(`(${column}::timestamp - interval '2 hours')`)
const num = (v: bigint | number | null) => Number(v ?? 0)

/** Per contract: Σ of a role over the journal's sources of that contract. */
function perLoan(journal: ReturnType<typeof journalByKey>, role: AccountRole): Map<string, number> {
  const out = new Map<string, number>()
  for (const { loanId, vector } of journal.values()) if (loanId && vector[role]) out.set(loanId, (out.get(loanId) ?? 0) + (vector[role] ?? 0))
  return out
}

/** Per recovery: Σ of a role over `recovery:<id>:*` sources, plus the proceeds payment's source for CLEARING. */
function perRecovery(journal: ReturnType<typeof journalByKey>, role: AccountRole, proceeds: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, { vector }] of journal) {
    const cents = vector[role]
    if (!cents) continue
    const recovery = /^recovery:([^:]+):/.exec(key)?.[1] ?? (key.startsWith("payment:") ? proceeds.get(key.slice("payment:".length)) : undefined)
    if (recovery) out.set(recovery, (out.get(recovery) ?? 0) + cents)
  }
  return out
}

function compare(control: string, journal: Map<string, number>, book: Map<string, number>): ControlMismatch[] {
  const out: ControlMismatch[] = []
  for (const key of [...new Set([...journal.keys(), ...book.keys()])].sort()) {
    const j = journal.get(key) ?? 0
    const b = book.get(key) ?? 0
    if (j !== b) out.push({ control, key, journalCents: j, bookCents: b })
  }
  return out
}

async function vatBooks(db: Db, tenantId: string, asOf: Date): Promise<{ output: Map<string, number>; input: Map<string, number> }> {
  const supply = sast('i."supplyDate"')
  const issue = sast('i."issueDate"')
  const incurred = sast('c."incurredOn"')
  const event = sast('v."eventDate"')
  const credit = sast('n."issueDate"')
  const released = Prisma.sql`p."status" = 'RELEASED' AND p."releasedAt" < ${asOf}`
  const rows = await db.$queryRaw<Array<{ kind: string; loanId: string; cents: bigint }>>(Prisma.sql`
    SELECT 'OUT' AS kind, i."loanId", SUM(i."vatCents")::bigint AS cents
      FROM "TaxInvoice" i JOIN "Loan" ln ON ln."id" = i."loanId" AND ln."tenantId" = i."tenantId"
      WHERE i."tenantId" = ${tenantId} AND ln."contractType" <> 'LOAN' AND ${supply} < ${asOf} GROUP BY i."loanId"
    UNION ALL
    SELECT 'OUT', rec."loanId", SUM(i."vatCents")::bigint
      FROM "RemarketingSale" rs JOIN "Recovery" rec ON rec."id" = rs."recoveryId" JOIN "TaxInvoice" i ON i."id" = rs."taxInvoiceId"
      WHERE rs."tenantId" = ${tenantId} AND rs."status" = 'COMPLETED' AND ${issue} < ${asOf} GROUP BY rec."loanId"
    UNION ALL
    SELECT 'OUT', i."loanId", -SUM(n."vatCents")::bigint
      FROM "CreditNote" n JOIN "TaxInvoice" i ON i."id" = n."invoiceId" JOIN "Loan" ln ON ln."id" = i."loanId" AND ln."tenantId" = i."tenantId"
      WHERE n."tenantId" = ${tenantId} AND ln."contractType" <> 'LOAN' AND ${credit} < ${asOf} GROUP BY i."loanId"
    UNION ALL
    SELECT 'IN', i."loanId", SUM(i."vatCents")::bigint
      FROM "TaxInvoice" i JOIN "Loan" ln ON ln."id" = i."loanId" AND ln."tenantId" = i."tenantId"
      WHERE i."tenantId" = ${tenantId} AND ln."contractType" IN ('INSTALMENT_SALE', 'FINANCE_LEASE') AND ${supply} < ${asOf}
        AND i."number" = (SELECT MIN(f."number") FROM "TaxInvoice" f WHERE f."loanId" = i."loanId" AND f."tenantId" = i."tenantId")
      GROUP BY i."loanId"
    UNION ALL
    SELECT 'IN', ln."id", SUM(a."vatCents")::bigint
      FROM "Loan" ln JOIN "FinancedAsset" a ON a."id" = ln."assetId" AND a."tenantId" = ln."tenantId"
        JOIN "AssetFinanceDeal" d ON d."loanId" = ln."id" AND d."tenantId" = ln."tenantId" JOIN "Payout" p ON p."dealId" = d."id" AND p."tenantId" = d."tenantId"
      WHERE ln."tenantId" = ${tenantId} AND ln."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND ${released} GROUP BY ln."id"
    UNION ALL
    SELECT 'IN', rec."loanId", SUM(v."inputTaxClaimCents")::bigint
      FROM "RecoveryVatEvent" v JOIN "Recovery" rec ON rec."id" = v."recoveryId"
      WHERE v."tenantId" = ${tenantId} AND v."kind" = 'REPOSSESSION_DEEMED_SUPPLY' AND ${event} < ${asOf} GROUP BY rec."loanId"
    UNION ALL
    SELECT 'IN', rec."loanId", SUM(c."vatCents")::bigint
      FROM "RecoveryCost" c JOIN "Recovery" rec ON rec."id" = c."recoveryId"
      WHERE c."tenantId" = ${tenantId} AND c."status" = 'APPROVED' AND ${incurred} < ${asOf} GROUP BY rec."loanId"
  `)
  const output = new Map<string, number>()
  const input = new Map<string, number>()
  for (const r of rows) {
    const target = r.kind === "OUT" ? output : input
    // Output VAT is a credit in the journal, input VAT a debit.
    target.set(r.loanId, (target.get(r.loanId) ?? 0) + (r.kind === "OUT" ? -num(r.cents) : num(r.cents)))
  }
  return { output, input }
}

interface RecoveryBook { id: string; proceedsPaymentId: string | null; resolved: boolean; result: number; refundPayable: number }

/** Per recovery: whether it is resolved by `asOf`, the result that resolution moves out of clearing, and the refund still owed. */
async function recoveryBooks(db: Db, tenantId: string, asOf: Date): Promise<RecoveryBook[]> {
  const frozen = sast('rec."chargesFrozenFrom"')
  const incurred = sast('c."incurredOn"')
  const issue = sast('i."issueDate"')
  const event = sast('v."eventDate"')
  const rows = await db.$queryRaw<Array<{ id: string; proceedsPaymentId: string | null; resolved: boolean; result: bigint; refundPayable: bigint }>>(Prisma.sql`
    SELECT rec."id", rec."proceedsPaymentId",
      ((rec."netProceedsCents" IS NOT NULL AND ${frozen} < ${asOf}) OR (rec."status" = 'WITHDRAWN' AND rec."closedAt" < ${asOf})) AS "resolved",
      (COALESCE((SELECT SUM(c."netCents") FROM "RecoveryCost" c WHERE c."recoveryId" = rec."id" AND c."status" = 'APPROVED' AND c."treatment" = 'DEDUCT_FROM_PROCEEDS' AND ${incurred} < ${asOf}), 0)
        + CASE WHEN rec."netProceedsCents" IS NOT NULL THEN LEAST(rec."netProceedsCents", rec."settlementDueCents") + COALESCE(rec."surplusCents", 0) ELSE 0 END
        - COALESCE((SELECT SUM(i."totalExclVatCents") FROM "RemarketingSale" rs JOIN "TaxInvoice" i ON i."id" = rs."taxInvoiceId" WHERE rs."recoveryId" = rec."id" AND rs."status" = 'COMPLETED' AND ${issue} < ${asOf}), 0)
        - COALESCE((SELECT SUM(v."inputTaxClaimCents") FROM "RecoveryVatEvent" v WHERE v."recoveryId" = rec."id" AND v."kind" = 'REPOSSESSION_DEEMED_SUPPLY' AND ${event} < ${asOf}), 0))::bigint AS "result",
      (CASE WHEN rec."netProceedsCents" IS NOT NULL AND ${frozen} < ${asOf} THEN COALESCE(rec."surplusCents", 0) ELSE 0 END
        - COALESCE((SELECT SUM(f."amountCents") FROM "RecoveryRefund" f WHERE f."recoveryId" = rec."id" AND f."status" = 'RELEASED' AND f."releasedAt" < ${asOf}), 0))::bigint AS "refundPayable"
    FROM "Recovery" rec WHERE rec."tenantId" = ${tenantId}
  `)
  return rows.map((r) => ({ id: r.id, proceedsPaymentId: r.proceedsPaymentId, resolved: r.resolved, result: num(r.result), refundPayable: num(r.refundPayable) }))
}

async function fundBooks(db: Db, tenantId: string, asOf: Date): Promise<Map<string, number>> {
  const on = sast('m."occurredOn"')
  const rows = await db.$queryRaw<Array<{ loanId: string; liability: bigint }>>(Prisma.sql`
    SELECT f."loanId",
      (CASE WHEN f."riskModel" = 'LESSEE_SETTLED' THEN -COALESCE((SELECT SUM(CASE WHEN m."kind" IN ('CONTRIBUTION', 'SETTLEMENT_BILLED') THEN m."amountCents" ELSE -m."amountCents" END)
        FROM "MaintenanceFundMovement" m WHERE m."fundId" = f."id" AND ${on} < ${asOf}), 0) ELSE 0 END)::bigint AS "liability"
    FROM "MaintenanceFund" f WHERE f."tenantId" = ${tenantId}
  `)
  return new Map(rows.map((r) => [r.loanId, num(r.liability)]))
}

/** Every asset-finance control for the period ending at `asOf`; an empty list means all tie. */
export async function assetFinanceControls(
  db: Db, tenantId: string, asOf: Date, journal: ReturnType<typeof journalByKey>,
): Promise<ControlMismatch[]> {
  const [vat, recoveries, funds] = await Promise.all([vatBooks(db, tenantId, asOf), recoveryBooks(db, tenantId, asOf), fundBooks(db, tenantId, asOf)])
  const proceeds = new Map(recoveries.flatMap((r) => (r.proceedsPaymentId ? [[r.proceedsPaymentId, r.id] as const] : [])))
  const clearing = perRecovery(journal, "RECOVERY_CLEARING", proceeds)
  const result = perRecovery(journal, "RECOVERY_RESULT", proceeds)
  const refund = perRecovery(journal, "RECOVERY_REFUND_PAYABLE", proceeds)
  const resolved = recoveries.filter((r) => r.resolved)
  const subset = (map: Map<string, number>, ids: string[]) => new Map([...map].filter(([id]) => ids.includes(id)))
  const resolvedIds = resolved.map((r) => r.id)
  return [
    ...compare("AF_OUTPUT_VAT", perLoan(journal, "OUTPUT_VAT"), vat.output),
    ...compare("AF_INPUT_VAT", perLoan(journal, "INPUT_VAT"), vat.input),
    ...compare("RECOVERY_CLEARING", subset(clearing, resolvedIds), new Map()),
    // A recovery not yet resolved has moved nothing to its result.
    ...compare("RECOVERY_RESULT", result, new Map(resolved.map((r) => [r.id, r.result]))),
    // The refund payable is a credit in the journal.
    ...compare("RECOVERY_REFUND_PAYABLE", refund, new Map(recoveries.map((r) => [r.id, -r.refundPayable]))),
    ...compare("MAINTENANCE_FUND_LIABILITY", perLoan(journal, "MAINTENANCE_FUND_LIABILITY"), funds),
  ]
}
