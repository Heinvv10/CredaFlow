import Link from "next/link"
import { CreditCard, Download } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { formatDate, formatZAR, SAST_TIME_ZONE } from "@/lib/utils"
import { displayPaymentMethod } from "@/lib/payments/waiver"
import { staffLoanFigures } from "@/lib/loan/loan-page-figures"
import type { SettlementLoanLike, SettlementScheduleRow } from "@/lib/loan/settlement"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { SectionHeader } from "@/components/app-shell/SectionHeader"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { RepaymentScheduleTable } from "@/components/loans/RepaymentScheduleTable"
import { PaymentForm } from "@/components/loans/PaymentForm"
import { ChargesPanel } from "@/components/loans/ChargesPanel"
import { LoanNotes } from "@/components/loans/LoanNotes"

/**
 * The staff loan page for an entity-borrower (asset-finance) loan (goal
 * §4.11): who the borrower is, the asset, the balance and arrears, default
 * charges, the schedule (with its balloon and capitalised-interest note),
 * receipts, the record-payment form (the same /api/payments capture as a
 * consumer loan), and the statement and tax invoice downloads. None of the
 * consumer panels (KYC, affordability, PASQ, mandate, s129) apply.
 */
export interface StaffAssetLoan extends SettlementLoanLike {
  id: string
  reference: string
  status: string
  outstandingPrincipal: number
  arrearsAmount: number
  daysInArrears: number
  balloonAmount: number | null
  entity: { id: string; legalName: string; registrationNumber: string } | null
  asset: { id: string; make: string; model: string; year: number; serialNumber: string; registrationNumber: string | null } | null
  assetFinanceDeal: { id: string } | null
  product: { name: string }
  repaymentSchedule: Array<SettlementScheduleRow & {
    id: string
    installmentNo: number
    principalDue: number
    interestDue: number
    feesDue: number
    status: string
    paidAt: Date | null
  }>
  payments: Array<{ id: string; amount: number; paymentMethod: string; receivedAt: Date; reversed: boolean; allocationStatus: string }>
}

const row = (label: string, value: React.ReactNode) => (
  <div className="flex justify-between gap-4">
    <span className="text-[var(--cf-text-muted)]">{label}</span>
    <span className="text-right font-medium text-[var(--cf-text)]">{value}</span>
  </div>
)

export async function StaffAssetLoanView({ loan, tenantId, canAuthoriseBackdate, canManageCharges }: {
  loan: StaffAssetLoan
  tenantId: string
  canAuthoriseBackdate: boolean
  canManageCharges: boolean
}) {
  const [figures, invoice] = await Promise.all([
    staffLoanFigures(prisma, { ...loan, tenantId }, new Date()),
    prisma.taxInvoice.findFirst({ where: { tenantId, loanId: loan.id }, orderBy: { number: "asc" }, select: { id: true, invoiceNumber: true } }),
  ])
  const { charges, settlementAmount, balance, maturityBalance, arrears, waivable, chargesNotDerived } = figures
  const nextPayment = loan.repaymentSchedule.find((s) => s.totalDue > 0 && (s.status === "PENDING" || s.status === "PARTIAL"))
  const skipRows = loan.repaymentSchedule.filter((s) => s.totalDue === 0).length
  const balloon = loan.balloonAmount ?? 0
  const name = loan.entity?.legalName ?? loan.reference

  return (
    <div className="space-y-6 p-4 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Breadcrumbs items={[{ label: "Loans", href: "/loans" }, { label: name }]} />
        <div className="flex flex-wrap gap-2 text-sm">
          <a href={`/api/loans/${loan.id}/statement`} className="inline-flex items-center gap-1 rounded-md border border-[var(--cf-border-strong)] px-3 py-1.5 text-[var(--cf-text)] hover:bg-[var(--cf-surface-strong)]">
            <Download className="h-4 w-4" /> Statement
          </a>
          {invoice && (
            <a href={`/api/asset-finance/tax-invoices/${invoice.id}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--cf-border-strong)] px-3 py-1.5 text-[var(--cf-text)] hover:bg-[var(--cf-surface-strong)]">
              <Download className="h-4 w-4" /> Tax invoice {invoice.invoiceNumber}
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <DataPanel title="Asset finance loan" description={`Reference ${loan.reference} · ${loan.product.name}`} variant="raised" density="loose"
            actions={<StatusPill tone={loan.daysInArrears > 0 ? "warning" : "neutral"}>{loan.status.replace(/_/g, " ")}</StatusPill>}>
            <div className="grid gap-4 sm:grid-cols-3">
              <MetricCard label={charges || settlementAmount === balance ? "Balance Remaining" : "Balance at maturity"} value={formatZAR(balance)} />
              <MetricCard label="Arrears" value={formatZAR(arrears)} tone={loan.daysInArrears > 0 ? "warning" : "neutral"} />
              <MetricCard label="Next payment" value={nextPayment ? `${formatZAR(nextPayment.totalDue - nextPayment.totalPaid)} on ${formatDate(nextPayment.dueDate)}` : "-"} />
            </div>
            {loan.daysInArrears > 0 && (
              <p className="mt-4 text-sm text-[var(--cf-text-muted)]">{loan.daysInArrears} days in arrears.</p>
            )}
          </DataPanel>

          <DataPanel title="Repayment schedule" variant="default" density="loose">
            <div className="mb-4 space-y-1 text-sm text-[var(--cf-text-muted)]">
              {balloon > 0 && <p>The final instalment includes the balloon of {formatZAR(balloon)}.</p>}
              {skipRows > 0 && (
                <p>
                  {skipRows} period{skipRows === 1 ? " has" : "s have"} no payment (R0.00). Interest those periods accrue is capitalised: it is added
                  to the balance and repaid as principal by later instalments.
                </p>
              )}
            </div>
            <RepaymentScheduleTable loanId={loan.id} schedule={loan.repaymentSchedule} allowAdminActions={false} />
          </DataPanel>
        </div>

        <div className="space-y-6 lg:col-span-5">
          <DataPanel title="Borrower" description="Business entity" variant="default" density="loose">
            <div className="space-y-3 text-sm">
              {row("Legal name", loan.entity
                ? <Link href={`/asset-finance/entities/${loan.entity.id}`} className="hover:text-[var(--cf-brand)]">{loan.entity.legalName}</Link>
                : "-")}
              {row("Registration number", loan.entity?.registrationNumber ?? "-")}
              {loan.assetFinanceDeal && row("Deal", <Link href={`/asset-finance/deals/${loan.assetFinanceDeal.id}`} className="hover:text-[var(--cf-brand)]">View deal</Link>)}
            </div>
          </DataPanel>

          {loan.asset && (
            <DataPanel title="Asset" variant="subtle" density="loose">
              <div className="space-y-3 text-sm">
                {row("Asset", <Link href={`/asset-finance/assets/${loan.asset.id}`} className="hover:text-[var(--cf-brand)]">{`${loan.asset.year} ${loan.asset.make} ${loan.asset.model}`}</Link>)}
                {row("Serial / VIN", loan.asset.serialNumber)}
                {loan.asset.registrationNumber && row("Registration", loan.asset.registrationNumber)}
              </div>
            </DataPanel>
          )}

          {(charges || waivable || chargesNotDerived) && (
            <ChargesPanel loanId={loan.id} charges={charges} waivable={waivable} settlementAmount={settlementAmount}
              canManage={canManageCharges} chargesNotDerived={chargesNotDerived} />
          )}

          {/* Capture eligibility tracks lib/loan/apply-payment.ts (ACTIVE / DEFAULTED). */}
          {["ACTIVE", "DEFAULTED"].includes(loan.status) && (
            <DataPanel variant="accent" density="loose">
              <SectionHeader eyebrow="Servicing" title="Record payment" description="Capture a receipt against this agreement."
                actions={<CreditCard className="h-5 w-5 text-[var(--cf-brand)]" />} className="mb-5" />
              <PaymentForm loanId={loan.id} settlementAmount={settlementAmount} contractualBalance={maturityBalance}
                loanStartDay={loan.startDate.toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })}
                canAuthoriseBackdate={canAuthoriseBackdate} />
            </DataPanel>
          )}

          <DataPanel title="Receipts" variant="default" density="loose">
            {loan.payments.length === 0 ? (
              <p className="text-sm text-[var(--cf-text-muted)]">No payments recorded</p>
            ) : (
              <div className="space-y-3">
                {loan.payments.map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between gap-4 border-b border-[var(--cf-border-subtle)] py-2 last:border-0">
                    <div>
                      <p className={`whitespace-nowrap font-semibold ${payment.reversed ? "text-[var(--cf-text-muted)] line-through" : "text-[var(--cf-text)]"}`}>{formatZAR(payment.amount)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{displayPaymentMethod(payment.paymentMethod, (method) => method)} - {formatDate(payment.receivedAt)}</p>
                    </div>
                    <StatusPill tone={payment.reversed ? "neutral" : payment.allocationStatus === "ALLOCATED" ? "success" : "warning"}>
                      {payment.reversed ? "Reversed" : payment.allocationStatus === "ALLOCATED" ? "Allocated" : payment.allocationStatus === "REFUNDED" ? "Refund recorded" : "Allocation pending"}
                    </StatusPill>
                  </div>
                ))}
              </div>
            )}
          </DataPanel>
        </div>
      </div>

      <DataPanel title="Contact history & notes" variant="default" density="loose">
        <LoanNotes loanId={loan.id} />
      </DataPanel>
    </div>
  )
}
