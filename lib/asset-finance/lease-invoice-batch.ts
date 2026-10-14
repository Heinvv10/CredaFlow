/**
 * The daily lease sweep behind app/api/cron/asset-finance-lease-invoices
 * (slice 3, C4): for every tenant with featureAssetFinance on, every
 * uninvoiced rental of a collectible lease (ACTIVE or DEFAULTED) whose due
 * date is today or earlier (SAST) gets its tax invoice, supply date = the due
 * date (./lease-invoices.ts). Each rental runs in its own transaction: one
 * failure is logged and counted and the sweep goes on. Idempotent: an
 * invoiced rental is not selected again, and a concurrent run waits on the
 * rental's lock and then finds the invoice.
 */
import type { prisma } from "@/lib/prisma"
import { dbDate, isoOfDbDate } from "./dates"
import { issueLeaseRentalInvoice } from "./lease-invoices"

type BatchDb = Pick<typeof prisma, "tenantConfig" | "leaseRental" | "$transaction">

export interface LeaseInvoiceRun {
  ok: boolean
  day: string
  issued: number
  alreadyInvoiced: number
  refused: Record<string, number>
  failed: number
}

export async function runLeaseInvoiceBatch(db: BatchDb, day: string): Promise<LeaseInvoiceRun> {
  const run: LeaseInvoiceRun = { ok: true, day, issued: 0, alreadyInvoiced: 0, refused: {}, failed: 0 }
  const tenants = await db.tenantConfig.findMany({ where: { featureAssetFinance: true }, orderBy: { tenantId: "asc" }, select: { tenantId: true } })
  for (const { tenantId } of tenants) {
    const due = await db.leaseRental.findMany({
      where: { tenantId, taxInvoiceId: null, dueDate: { lte: dbDate(day) }, loan: { status: { in: ["ACTIVE", "DEFAULTED"] } } },
      orderBy: [{ dueDate: "asc" }, { periodNo: "asc" }],
      select: { id: true, dueDate: true },
    })
    for (const rental of due) {
      try {
        const result = await db.$transaction((tx) => issueLeaseRentalInvoice(tx, {
          tenantId, rentalId: rental.id, supplyDate: isoOfDbDate(rental.dueDate), today: day, createdById: null, source: "cron",
        }))
        if (result.kind === "issued") run.issued++
        else if (result.kind === "already_invoiced") run.alreadyInvoiced++
        else if (result.kind === "refused") run.refused[result.reason] = (run.refused[result.reason] ?? 0) + 1
      } catch (error) {
        run.failed++
        run.ok = false
        console.error("[asset-finance-lease-invoices] rental failed", { tenantId, rentalId: rental.id, error })
      }
    }
  }
  return run
}
