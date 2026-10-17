/**
 * The daily lease steps run before the rental invoices by
 * app/api/cron/asset-finance-lease-invoices (./lease-invoice-batch.ts), each
 * lease in its own transaction:
 *
 * EXTENSIONS (C7). A lease on a month-to-month extension (end of term
 * EXTENDING) whose last rental has fallen due gets its next rental, one month
 * later, at the last rental and maintenance (./lease-charges.ts
 * appendExtensionRental) — one period at a time — unless the extension was
 * ended and the next rental would fall after its end (in advance: on or after it). The invoice step then
 * invoices it once due.
 *
 * EXPIRY NOTICES (C7, CPA s14). A CPA lessee's lease whose term expires in
 * 40–80 business days (./lease-expiry.ts) gets its expiry notice once
 * (LeaseExpiryNotice, unique per loan).
 * PARTIAL: queued, not sent. The messaging pipeline has no deferred
 * outbox and borrower copy needs the lender's sign-off before it exists
 * (the same position as ./reprice-notice.ts), so the notice is recorded and a
 * bell item asks the loan admins to send the rendered notice
 * (documents/lease/expiry-notice-pdf.ts). Nothing reaches a borrower.
 * Notice window signed off (see DESIGN.md sign-off record 2026-10-17).
 */
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { appendExtensionRental } from "./lease-charges"
import { expiryNoticeDue } from "./lease-expiry"
import { alertLoanAdmins } from "./reprice-notice"

type DailyDb = Pick<typeof prisma, "leaseEndOfTerm" | "loan" | "$transaction">

export interface DailyRun {
  extensionRentals: number
  expiryNotices: number
  failed: number
}

/** The day a lease's fixed term expires: a month after the last rental in advance, the last rental's day in arrears. */
export function leaseExpiryDate(lastRentalDue: Date, timing: string | null): string {
  const last = sastCalendarDate(lastRentalDue)
  return timing === "ADVANCE" ? addMonthsClamped(last, 1) : last
}

export async function runLeaseExtensions(db: DailyDb, tenantId: string, today: string, run: DailyRun): Promise<void> {
  const extending = await db.leaseEndOfTerm.findMany({ where: { tenantId, status: "EXTENDING", loan: { status: { in: ["ACTIVE", "COMPLETED", "DEFAULTED"] } } }, select: { loanId: true, extensionEndsOn: true, loan: { select: { assetFinanceDeal: { select: { rentalTiming: true } } } } } })
  for (const row of extending) {
    try {
      await db.$transaction(async (tx) => {
        const last = await tx.leaseRental.findFirstOrThrow({ where: { tenantId, loanId: row.loanId }, orderBy: { periodNo: "desc" }, select: { dueDate: true } })
        const lastDue = isoOfDbDate(last.dueDate)
        if (lastDue > today) return
        const next = addMonthsClamped(lastDue, 1)
        // In advance a rental due on the end date would pay for the month after it: only rentals due before the end.
        const endsOn = row.extensionEndsOn ? isoOfDbDate(row.extensionEndsOn) : null
        if (endsOn && (row.loan.assetFinanceDeal?.rentalTiming === "ADVANCE" ? next >= endsOn : next > endsOn)) return
        const appended = await appendExtensionRental(tx, { tenantId, loanId: row.loanId, vat: await loadRateOn(tx, next > today ? today : next), actorUserId: null })
        await logAuditStrict({ tenantId, action: AuditAction.LEASE_EXTENDED, entity: "Loan", entityId: row.loanId, newValue: { ...appended, source: "cron" } }, tx)
        run.extensionRentals++
      })
    } catch (error) {
      run.failed++
      console.error("[asset-finance-lease-daily] extension failed", { tenantId, loanId: row.loanId, error: error instanceof Error ? error.name : "unknown" })
    }
  }
}

export async function runExpiryNotices(db: DailyDb, tenantId: string, today: string, run: DailyRun): Promise<void> {
  const leases = await db.loan.findMany({
    where: { tenantId, status: { in: ["ACTIVE", "DEFAULTED"] }, cpaApplies: true, leaseExpiryNotice: null, leaseEndOfTerm: null },
    select: { id: true, reference: true, maturityDate: true, assetFinanceDeal: { select: { rentalTiming: true } } },
  })
  for (const lease of leases) {
    const expiryDate = leaseExpiryDate(lease.maturityDate, lease.assetFinanceDeal?.rentalTiming ?? null)
    if (!expiryNoticeDue({ today, expiryDate, cpaApplies: true })) continue
    try {
      await db.$transaction(async (tx) => {
        await tx.leaseExpiryNotice.create({ data: { tenantId, loanId: lease.id, expiryDate: dbDate(expiryDate), queuedOn: dbDate(today) } })
        await alertLoanAdmins(tx, tenantId, {
          type: "LEASE_EXPIRY_NOTICE", title: `CPA expiry notice due: lease ${lease.reference}`,
          body: `Lease ${lease.reference} expires on ${expiryDate}. Send the lessee the CPA expiry notice (40–80 business days before expiry).`,
          entityType: "Loan", entityId: lease.id,
        })
        await logAuditStrict({ tenantId, action: AuditAction.LEASE_EXPIRY_NOTICE_QUEUED, entity: "Loan", entityId: lease.id, newValue: { expiryDate, queuedOn: today, sent: false } }, tx)
      })
      run.expiryNotices++
    } catch (error) {
      run.failed++
      console.error("[asset-finance-lease-daily] expiry notice failed", { tenantId, loanId: lease.id, error: error instanceof Error ? error.name : "unknown" })
    }
  }
}
