import Link from "next/link"
import { CreditCard, Download } from "lucide-react"
import type { ContractType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { formatDate, SAST_TIME_ZONE } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { paymentMethodLabel, statusLabel } from "@/lib/asset-finance/labels"
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
import { LeaseStaffPanel } from "@/components/asset-finance/lease/LeaseStaffPanel"
import { isLeaseContract } from "@/lib/asset-finance/lease-input"

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
  contractType: ContractType
  outstandingPrincipal: number
  arrearsAmount: number
  daysInArrears: number
  balloonAmount: number | null
  entity: { id: string; legalName: string; registrationNumber: string } | null
  /** A sole-proprietor lessee: a lease can be held by a client (a loan to a client is not asset finance). */
  client: { id: string; firstName: string; lastName: string } | null
  asset: { id: string; make: string; model: string; year: number; serialNumber: string; registrationNumber: string | null } | null
  assetFinanceDeal: { id: string } | null
  /** appliedAmount is the amount financed */
  application: { appliedAmount: number } | null
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

// Sized so R 99,999,999.99 fits a card at 1280 and at 375 wide.
const metric = (text: string) => <span className="block text-xl tabular-nums xl:text-2xl">{text}</span>

const row = (label: string, value: React.ReactNode) => (
  <div className="flex justify-between gap-4">
    <span className="text-[var(--cf-text-muted)]">{label}</span>
    <span className="text-right font-medium text-[var(--cf-text)]">{value}</span>
  </div>
)

export async function StaffAssetLoanView({ loan, tenantId, userId, canManageLease, canDecideLease, canAuthoriseBackdate, canManageCharges }: {
  loan: StaffAssetLoan
  tenantId: string
  userId: string
  canManageLease: boolean
  canDecideLease: boolean
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
  const lease = isLeaseContract(loan.contractType)
  const lessee = loan.client ? `${loan.client.firstName} ${loan.client.lastName}`.trim() : null
  const name = loan.entity?.legalName ?? lessee ?? loan.reference
  const financed = loan.application?.appliedAmount ?? null

  return (
    <div className="space-y-6 p-4 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Breadcrumbs items={[{ label: "Loans", href: "/loans" }, { label: name }]} />
        <div className="flex flex-wrap gap-2 text-sm">
          <a href={`/api/loans/${loan.id}/statement`} className="inline-flex items-center gap-1 rounded-md border border-[var(--cf-border-strong)] px-3 py-1.5 text-[var(--cf-text)] hover:bg-[var(--cf-surface-strong)]">
            <Download className="h-4 w-4" /> Statement
          </a>
          {/* A lease bills a tax invoice per rental: they are linked from the rentals table. */}
          {invoice && !lease && (
            <a href={`/api/asset-finance/tax-invoices/${invoice.id}`} className="inline-flex items-center gap-1 rounded-md border border-[var(--cf-border-strong)] px-3 py-1.5 text-[var(--cf-text)] hover:bg-[var(--cf-surface-strong)]">
              <Download className="h-4 w-4" /> Tax invoice {invoice.invoiceNumber}
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <DataPanel title={lease ? "Lease" : "Asset finance loan"} description={`Reference ${loan.reference} · ${loan.product.name}`} variant="raised" density="loose"
            actions={<StatusPill tone={loan.daysInArrears > 0 ? "warning" : "neutral"}>{statusLabel(loan.status)}</StatusPill>}>
            {/* While default charges are live the balance is the settlement figure (staffLoanFigures). */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {lease ? (
                <>
                  {/* Not an early termination: ending a lease early is by quotation (the lease panel). */}
                  <MetricCard label="Rentals outstanding" value={metric(formatMoney(balance))}
                    detail={charges ? "Every rental still to pay incl. VAT, default charges included" : "Every rental still to pay incl. VAT: not an early-termination figure"} />
                  <MetricCard label="All rentals over the term" value={metric(formatMoney(loan.principal))} detail="Incl. VAT and maintenance" />
                </>
              ) : (
                <>
                  <MetricCard label={charges ? "Amount to settle today" : "Balance remaining"} value={metric(formatMoney(balance))}
                    detail={charges ? "Settles the agreement today, default charges included" : "Principal + scheduled interest still to pay"} />
                  <MetricCard label="Outstanding principal" value={metric(formatMoney(loan.outstandingPrincipal))}
                    detail="Includes capitalised interest" />
                </>
              )}
              <MetricCard label="Arrears" value={metric(formatMoney(arrears))} tone={loan.daysInArrears > 0 ? "warning" : "neutral"} />
              <MetricCard label="Next payment" value={metric(nextPayment ? formatMoney(nextPayment.totalDue - nextPayment.totalPaid) : "None scheduled")}
                detail={nextPayment ? `Due ${formatDate(nextPayment.dueDate)}` : undefined} />
            </div>
            {loan.daysInArrears > 0 && (
              <p className="mt-4 text-sm text-[var(--cf-text-muted)]">{loan.daysInArrears} days in arrears.</p>
            )}
          </DataPanel>

          <DataPanel title="Repayment schedule" variant="default" density="loose">
            <div className="mb-4 space-y-1 text-sm text-[var(--cf-text-muted)]">
              {balloon > 0 && <p>The final instalment includes the balloon of {formatMoney(balloon)}.</p>}
              {lease && (
                <p>Each row is a rental incl. VAT and maintenance, or an end-of-term or early-termination charge. The split is in the rentals table below.</p>
              )}
              {!lease && financed !== null && loan.principal > financed && (
                <p>
                  The principal ({formatMoney(loan.principal)}) is more than the {formatMoney(financed)} financed: interest that lower or
                  skipped instalments do not cover is capitalised (added to the balance and repaid as principal).
                </p>
              )}
              {!lease && skipRows > 0 && (
                <p>
                  {skipRows} period{skipRows === 1 ? " has" : "s have"} no payment (R0.00). Interest those periods accrue is capitalised: it is added
                  to the balance and repaid as principal by later instalments.
                </p>
              )}
            </div>
            {/* Money and dates on one line each; the table scrolls sideways in its own container. */}
            <div className="[&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
              <RepaymentScheduleTable loanId={loan.id} schedule={loan.repaymentSchedule} allowAdminActions={false}
                statusLabels={Object.fromEntries(loan.repaymentSchedule.map((s) => [s.status, statusLabel(s.status)]))} />
            </div>
          </DataPanel>
        </div>

        <div className="space-y-6 lg:col-span-5">
          <DataPanel title={lease ? "Lessee" : "Borrower"} description={loan.entity ? "Business entity" : "Sole proprietor"} variant="default" density="loose">
            <div className="space-y-3 text-sm">
              {loan.entity ? (
                <>
                  {row("Legal name", <Link href={`/asset-finance/entities/${loan.entity.id}`} className="hover:text-[var(--cf-brand)]">{loan.entity.legalName}</Link>)}
                  {row("Registration number", loan.entity.registrationNumber)}
                </>
              ) : (
                row("Name", loan.client && lessee ? <Link href={`/clients/${loan.client.id}`} className="hover:text-[var(--cf-brand)]">{lessee}</Link> : "-")
              )}
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
                      <p className={`whitespace-nowrap font-semibold ${payment.reversed ? "text-[var(--cf-text-muted)] line-through" : "text-[var(--cf-text)]"}`}>{formatMoney(payment.amount)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">{paymentMethodLabel(payment.paymentMethod)} · {formatDate(payment.receivedAt)}</p>
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

      {lease && <LeaseStaffPanel tenantId={tenantId} loanId={loan.id} userId={userId} canManage={canManageLease} canDecide={canDecideLease} />}

      <DataPanel title="Contact history & notes" variant="default" density="loose">
        <LoanNotes loanId={loan.id} />
      </DataPanel>
    </div>
  )
}
