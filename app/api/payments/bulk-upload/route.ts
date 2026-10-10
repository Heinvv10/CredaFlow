import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { recomputeLoanBalances, nextPaymentDueDate } from "@/lib/loan/balances"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { CHARGES_FLAG_INCLUDE, chargesEnabled } from "@/lib/loan/charges-replay"
import { projectChargeAwareReceipt } from "@/lib/loan/charge-aware-receipt"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { ChargesSyncRefused } from "@/lib/loan/charges-verdict"
import { ChargesError } from "@/lib/loan/charges-error"
import { recordHeldReceipt } from "@/lib/payments/held-receipt"
import { restampSchedulePaidAt } from "@/lib/loan/schedule-paid-at"
import type { PaymentMethod } from "@prisma/client"
import { receiptContractualTotalsUpdate, settlementAuditEvidence } from "@/lib/loan/settlement"
import { OVERPAYMENT_REASON } from "@/lib/loan/receipt-rules"

interface CsvRow {
  reference: string    // loan reference e.g. LN-20260224-0010
  amount: number       // in Rands (we convert to cents)
  method?: string      // EFT | CASH | DEBIT_ORDER | CARD
  paymentRef?: string  // bank reference
  notes?: string
}

const VALID_METHODS = ["EFT", "CASH", "DEBIT_ORDER", "CARD"]

function parseAmount(val: string): number {
  // strip R, spaces, commas
  const clean = val.replace(/[R\s,]/g, "").trim()
  return Math.round(parseFloat(clean) * 100)  // convert to cents
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const body = await req.json() as { rows: CsvRow[] }
      const { rows } = body

      if (!Array.isArray(rows) || rows.length === 0) {
        return NextResponse.json({ error: "No rows provided" }, { status: 422 })
      }

      if (rows.length > 500) {
        return NextResponse.json({ error: "Max 500 rows per upload" }, { status: 422 })
      }

      const results = {
        processed: 0,
        skipped: 0,
        errors: [] as { row: number; reference: string; reason: string }[],
        payments: [] as { id: string; loanRef: string; amount: number }[],
        /** money beyond what settles a loan: recorded refund-due, as capture books it */
        refundDue: [] as { id: string; row: number; loanRef: string; amount: number }[],
        /** rows the charges replay refused: the money is held for reconciliation, not dropped */
        held: [] as { id: string; row: number; loanRef: string; amount: number; reason: string }[],
      }

      // Resolve reference -> loan id up front. Ids are stable (a payment never
      // changes a loan's identity), so this pre-read is only for grouping +
      // "loan not found" reporting; the authoritative balance is re-read UNDER
      // the lock inside each transaction below.
      const references = [...new Set(rows.map(r => r.reference).filter(Boolean))]
      const idByRef = new Map(
        (await prisma.loan.findMany({
          where: { tenantId: tenant.id, reference: { in: references } },
          select: { id: true, reference: true },
        })).map(l => [l.reference, l.id]),
      )

      // Parse + validate each row, grouping the good ones by loan reference so we
      // can process one loan per transaction (see below).
      interface ParsedRow { rowIdx: number; amountCents: number; method: string; paymentRef: string | null; notes: string }
      const byRef = new Map<string, ParsedRow[]>()
      rows.forEach((row, idx) => {
        const rowIdx = idx + 1
        if (!row.reference?.trim()) {
          results.errors.push({ row: rowIdx, reference: "", reason: "Missing loan reference" })
          results.skipped++
          return
        }
        const amountCents = typeof row.amount === "number"
          ? Math.round(row.amount * 100)
          : parseAmount(String(row.amount))
        if (isNaN(amountCents) || amountCents <= 0) {
          results.errors.push({ row: rowIdx, reference: row.reference, reason: "Invalid amount" })
          results.skipped++
          return
        }
        if (!idByRef.has(row.reference)) {
          results.errors.push({ row: rowIdx, reference: row.reference, reason: "Loan not found" })
          results.skipped++
          return
        }
        const method = VALID_METHODS.includes(row.method?.toUpperCase() ?? "")
          ? row.method!.toUpperCase()
          : "EFT"
        const list = byRef.get(row.reference) ?? []
        list.push({ rowIdx, amountCents, method, paymentRef: row.paymentRef ?? null, notes: row.notes ?? "Bulk upload" })
        byRef.set(row.reference, list)
      })

      // ONE transaction per loan, each taking a FOR UPDATE lock on that single
      // loan before reading its balance. One loan per tx means each
      // tx only ever holds one loan lock, so there is no lock-ordering deadlock
      // against concurrent bulk uploads or the single-loan payment paths.
      for (const [reference, parsedRows] of byRef) {
        const loanId = idByRef.get(reference)!

        await prisma.$transaction(async (tx) => {
          await lockLoanForUpdate(tx, loanId)

          const loan = await tx.loan.findUnique({
            where: { id: loanId, tenantId: tenant.id },
            select: {
              id: true,
              status: true,
              principal: true,
              totalInterest: true,
              totalPaid: true,
              totalRepayable: true,
              contractualTotalInterest: true,
              contractualTotalRepayable: true,
              interestRatePm: true,
              interestModel: true,
              startDate: true,
              maturityDate: true,
              closedAt: true,
              tenant: CHARGES_FLAG_INCLUDE,
              repaymentSchedule: {
                // Full schedule (incl. PAID), earliest due first — balances are
                // recomputed from it, so we need every row + the split columns.
                orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
                select: { id: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
              },
            },
          })

          if (!loan) {
            for (const p of parsedRows) {
              results.errors.push({ row: p.rowIdx, reference, reason: "Loan not found" })
              results.skipped++
            }
            return
          }
          for (const p of parsedRows) {
            if (!["ACTIVE", "DEFAULTED"].includes(loan.status)) {
              // Nothing to allocate to, but the money arrived, so it is recorded:
              // refund-due on a settled loan (before the upload or by an earlier
              // row); on any other status held for reconciliation, as the Stitch
              // webhook does.
              const settled = loan.status === "COMPLETED"
              const held = await recordHeldReceipt(tx, {
                tenantId: tenant.id, loanId: loan.id, amount: p.amountCents, paymentMethod: p.method as PaymentMethod,
                reference: p.paymentRef, notes: p.notes, receivedAt: new Date(), capturedBy: guard.user.id,
                reason: settled ? OVERPAYMENT_REASON : "loan_not_allocatable",
                source: "bulk_upload", userId: guard.user.id, userEmail: guard.user.email ?? null,
              })
              const row = { id: held.id, row: p.rowIdx, loanRef: reference, amount: p.amountCents }
              if (settled) results.refundDue.push(row)
              else results.held.push({ ...row, reason: `Loan status is ${loan.status}` })
              continue
            }
            // Each row in a savepoint: a row the charges replay refuses is rolled
            // back alone and its money held, and the loan's in-memory state with it.
            const saved = { ...loan, repaymentSchedule: loan.repaymentSchedule.map((row) => ({ ...row })) }
            await tx.$executeRawUnsafe("SAVEPOINT bulk_row")
            try {
              const asOf = new Date()
              const chargesRef = { tenantId: tenant.id, loanId: loan.id }
              const chargesOn = chargesEnabled(loan)
              const { projection } = await projectChargeAwareReceipt(tx, {
                loan: { ...loan, tenantId: tenant.id },
                schedule: loan.repaymentSchedule,
                amount: p.amountCents,
                receivedAt: asOf,
                asOf,
                allowOverpayment: true,
              })
              const common = {
                tenantId: tenant.id,
                loanId: loan.id,
                paymentMethod: p.method as PaymentMethod,
                reference: p.paymentRef,
                notes: p.notes,
                // SYSTEM_OBSERVED: the CSV has no date column, so there is no
                // value date to record. Import time is the honest answer;
                // fabricating a past date would both misstate the client's NCA
                // statement and rebate interest nobody asserted.
                receivedAt: asOf,
                capturedBy: guard.user.id,
              }
              // Money arrived is always recorded. Beyond what settles the loan
              // it is refund-due, as the capture path books it; a row that finds
              // nothing to pay is refund-due whole.
              if (projection.appliedAmount === 0) {
                const held = await recordHeldReceipt(tx, {
                  ...common, amount: p.amountCents, reason: OVERPAYMENT_REASON, source: "bulk_upload",
                  userId: guard.user.id, userEmail: guard.user.email ?? null,
                })
                results.refundDue.push({ id: held.id, row: p.rowIdx, loanRef: reference, amount: p.amountCents })
                await tx.$executeRawUnsafe("RELEASE SAVEPOINT bulk_row")
                continue
              }
              const payment = await tx.payment.create({ data: { ...common, amount: projection.appliedAmount } })
              if (projection.excessAmount > 0) {
                const excess = await tx.payment.create({
                  data: {
                    ...common, amount: projection.excessAmount, allocationStatus: "UNAPPLIED",
                    reconciliationReason: OVERPAYMENT_REASON, parentPaymentId: payment.id,
                  },
                })
                results.refundDue.push({ id: excess.id, row: p.rowIdx, loanRef: reference, amount: projection.excessAmount })
              }

              // Allocate the receipt across unpaid instalments (earliest first),
              // mutating the in-memory (locked) schedule so multiple payments to the
              // same loan compound correctly.
              for (let i = 0; i < projection.rows.length; i++) {
                const sched = loan.repaymentSchedule[i]
                const projected = projection.rows[i]
                const isPaid = projected.totalPaid >= projected.totalDue
                await tx.repaymentSchedule.update({
                  where: { id: sched.id },
                  data: {
                    totalPaid: projected.totalPaid,
                    interestDue: projected.interestDue,
                    totalDue: projected.totalDue,
                    status: isPaid ? "PAID" : "PARTIAL",
                    paidAt: isPaid ? asOf : null,
                  },
                })
                sched.totalPaid = projected.totalPaid
                sched.interestDue = projected.interestDue
                sched.totalDue = projected.totalDue
              }
              // The loop above dates every paid row by this upload, including
              // rows earlier receipts paid: re-date every row from the replay.
              if (!chargesOn) {
                await restampSchedulePaidAt(tx, chargesRef, {
                  source: "bulk_upload", userId: guard.user.id, userEmail: guard.user.email ?? null,
                })
              }

              // Recompute balances from the full post-payment schedule: reduce principal only by the principal portion paid,
              // and never zero genuine arrears.
              const balances = recomputeLoanBalances(loan.principal, loan.repaymentSchedule, asOf)
              const newTotalPaid = projection.newTotalPaid
              const isCompleted = projection.isCompleted
              const oldLoanValue = {
                status: loan.status,
                totalPaid: loan.totalPaid,
                totalInterest: loan.totalInterest,
                totalRepayable: loan.totalRepayable,
              }

              await tx.loan.update({
                where: { id: loan.id, tenantId: tenant.id },
                data: {
                  totalPaid: newTotalPaid,
                  totalInterest: projection.totalInterest,
                  totalRepayable: projection.totalRepayable,
                  ...receiptContractualTotalsUpdate(projection),
                  outstandingPrincipal: balances.outstandingPrincipal,
                  lastPaymentDate: asOf,
                  lastPaymentAmount: projection.appliedAmount,
                  nextPaymentDate: nextPaymentDueDate(loan.repaymentSchedule),
                  status: isCompleted ? "COMPLETED" : loan.status as "ACTIVE" | "DEFAULTED",
                  closedAt: isCompleted ? asOf : loan.closedAt,
                  daysInArrears: balances.daysInArrears,
                  arrearsAmount: balances.arrearsAmount,
                },
              })
              await tx.auditLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: guard.user.id,
                  userEmail: guard.user.email,
                  action: "PAYMENT_RECORDED",
                  entity: "Loan",
                  entityId: loan.id,
                  oldValue: oldLoanValue,
                  newValue: {
                    paymentId: payment.id,
                    amount: projection.appliedAmount,
                    excessAmount: projection.excessAmount,
                    method: p.method,
                    reference: p.paymentRef,
                    source: "bulk_upload",
                    status: isCompleted ? "COMPLETED" : loan.status,
                    totalPaid: newTotalPaid,
                    ...settlementAuditEvidence(projection),
                  },
                },
              })

              // Compound subsequent receipts to the same loan onto this fresh total.
              loan.totalPaid = newTotalPaid
              loan.totalInterest = projection.totalInterest
              loan.totalRepayable = projection.totalRepayable
              if (projection.isEarlyDailySettlement) {
                loan.contractualTotalInterest = projection.contractualTotalInterest
                loan.contractualTotalRepayable = projection.contractualTotalRepayable
              }
              loan.status = isCompleted ? "COMPLETED" : loan.status
              loan.closedAt = isCompleted ? asOf : loan.closedAt

              // The replay settles how this receipt splits between charges and
              // the schedule; the next row on this loan compounds onto its result.
              const synced = chargesOn
                ? await syncLoanCharges(tx, chargesRef, asOf, {
                    source: "bulk_upload",
                    userId: guard.user.id,
                    userEmail: guard.user.email ?? null,
                  })
                : null
              if (synced) {
                loan.totalPaid = synced.totalPaid
                loan.status = synced.status
                loan.closedAt = synced.closedAt
              }

              results.payments.push({ id: payment.id, loanRef: reference, amount: projection.appliedAmount })
              results.processed++
              await tx.$executeRawUnsafe("RELEASE SAVEPOINT bulk_row")
            } catch (error) {
              if (!(error instanceof ChargesError)) throw error
              await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT bulk_row")
              saved.repaymentSchedule.forEach((row, i) => Object.assign(loan.repaymentSchedule[i], row))
              Object.assign(loan, { ...saved, repaymentSchedule: loan.repaymentSchedule })
              const held = await recordHeldReceipt(tx, {
                tenantId: tenant.id, loanId: loan.id, amount: p.amountCents, paymentMethod: p.method as PaymentMethod,
                reference: p.paymentRef, notes: p.notes, receivedAt: new Date(), capturedBy: guard.user.id,
                error, source: "bulk_upload", userId: guard.user.id, userEmail: guard.user.email ?? null,
              })
              results.held.push({ id: held.id, row: p.rowIdx, loanRef: reference, amount: p.amountCents, reason: error.message })
            }
          }
          await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        })
      }

      await logAudit({
        action: "BULK_PAYMENTS_UPLOADED",
        entity: "Payment",
        entityId: "bulk",
        tenantId: tenant.id,
        userId: guard.user.id,
        newValue: {
          processed: results.processed, skipped: results.skipped, rows: rows.length,
          held: results.held.length, refundDue: results.refundDue.length,
        },
      })

      // Errors are collected in two passes (row-order validation, then per-loan
      // status checks), so re-sort by row number to keep the staff-facing list
      // in upload order.
      results.errors.sort((a, b) => a.row - b.row)

      return NextResponse.json(results)
    })
  } catch (err) {
    if (err instanceof ChargesSyncRefused) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    console.error(err)
    return NextResponse.json({ error: "Bulk upload failed" }, { status: 500 })
  }
}
