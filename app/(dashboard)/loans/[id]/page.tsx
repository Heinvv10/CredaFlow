import { RateCorrectionPanel } from "@/components/asset-finance/RateCorrectionPanel"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { prisma } from "@/lib/prisma"
import { displayPaymentMethod } from "@/lib/payments/waiver"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getSession } from "@/lib/auth-session"
import { canDo, hasMinRole } from "@/lib/auth-guards"
import { formatZAR, formatDate, SAST_TIME_ZONE } from "@/lib/utils"
import { getAvatarColor, getInitials } from "@/lib/avatar"
import { LoanNotes } from "@/components/loans/LoanNotes"
import { Button } from "@/components/ui/button"
import { RepaymentScheduleTable } from "@/components/loans/RepaymentScheduleTable"
import { PaymentForm } from "@/components/loans/PaymentForm"
import { LoanDocumentActions } from "@/components/loans/LoanDocumentActions"
import { LoanSummaryBadges } from "@/components/loans/LoanSummaryBadges"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { SectionHeader } from "@/components/app-shell/SectionHeader"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { CreditCard, User, Phone, Mail, Briefcase, Wallet } from "lucide-react"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { getSection129IssuanceAvailability } from "@/lib/collections/section129-artifact"
import { staffLoanFigures } from "@/lib/loan/loan-page-figures"
import { ChargesPanel } from "@/components/loans/ChargesPanel"
import { StaffAssetLoanView } from "@/components/asset-finance/StaffAssetLoanView"
import { hasClientBorrower } from "@/lib/borrower"
import { LoanCollectionsPanel } from "@/components/collections-engine/LoanCollectionsPanel"
import { DebtReviewPanel } from "@/components/collections/DebtReviewPanel"
import { loadClientHold, siblingNoticeFrom } from "@/lib/collections/client-holds"
import { isLeaseContract } from "@/lib/asset-finance/lease-input"
import { AssetLoanRecoveryPanels, hasRecoveryPanels } from "@/components/asset-finance/recovery/AssetLoanRecoveryPanels"
import { PayoutStatusPanel } from "@/components/payouts/PayoutStatusPanel"
import { loadPayoutView } from "@/lib/payouts/view"

async function getLoan(id: string, tenantId: string) {
  return prisma.loan.findUnique({
    where: { id, tenantId },
    include: {
      client: true,
      entity: { select: { id: true, legalName: true, registrationNumber: true } },
      asset: { select: { id: true, make: true, model: true, year: true, serialNumber: true, registrationNumber: true } },
      assetFinanceDeal: { select: { id: true } },
      product: true,
      application: true,
      repaymentSchedule: {
        orderBy: { installmentNo: "asc" },
      },
      payments: {
        // Sorted by the field the row displays, or the staff list reads as out
        // of order against the client's own statement.
        orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  })
}

export default async function LoanDetailPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const tenantId = await getStaffTenantId()
  const [loan, session] = await Promise.all([getLoan(id, tenantId), getSession()])

  if (!loan) {
    notFound()
  }
  // An entity borrower or a lease (asset finance; a sole-proprietor lessee is a
  // client): its own servicing view, without the consumer panels.
  if (!hasClientBorrower(loan) || isLeaseContract(loan.contractType)) {
    const role = session?.user?.role
    return (
      <StaffAssetLoanView
        loan={loan}
        tenantId={tenantId}
        userId={session?.user?.id ?? ""}
        canManageLease={role ? canDo(role, "manage_asset_finance") : false}
        canDecideLease={role ? canDo(role, "decide_asset_finance") : false}
        canRecordPayment={role ? canDo(role, "record_payment") : false}
        canCapturePayment={role ? canDo(role, "capture_payment") : false}
        canAuthoriseBackdate={session?.user?.role ? hasMinRole(session.user.role, "LOAN_ADMIN") : false}
        canManageCharges={session?.user?.role ? hasMinRole(session.user.role, "LOAN_ADMIN") : false}
        canManageDebtReview={Boolean(role && hasMinRole(role, "COLLECTIONS_OFFICER") && canDo(role, "act_on_collections"))}
        role={role}
      />
    )
  }

  const paidPercentage = loan.totalRepayable > 0
    ? (loan.totalPaid / loan.totalRepayable) * 100
    : 0

  // Default charges owed today are in every "what's owed" figure, because the
  // receipt paths include them; "paid" is cash received.
  // `settlementAmount` is what the client must actually pay TODAY, which is not
  // the maturity total: a DAILY_ACCRUAL loan settled early rebates the unearned
  // interest (NCA s125). The payment API enforces this figure, so showing
  // `outstanding` on the capture form quoted staff an amount the server would refuse.
  const {
    charges,
    settlementAmount,
    balance: outstanding,
    maturityBalance,
    arrears,
    cashPaid,
    waivable,
    chargesNotDerived,
  } = await staffLoanFigures(prisma, { ...loan, tenantId }, new Date())
  const canManageCharges = session?.user?.role ? hasMinRole(session.user.role, "LOAN_ADMIN") : false
  const initials = getInitials(loan.client.firstName, loan.client.lastName)
  const avatarColor = getAvatarColor(loan.client.firstName + loan.client.lastName)
  // A CANCELLED loan (reversed disbursement) has no next payment.
  const nextPayment = loan.status === "CANCELLED" ? undefined : loan.repaymentSchedule.find(s => s.status === "PENDING" || s.status === "PARTIAL")
  const dunningEligibility = evaluateCollectionsEligibility(loan, "DUNNING")
  const section129Availability = await getSection129IssuanceAvailability(tenantId, loan.id)
  const payout = await loadPayoutView(tenantId, loan.id, loan.status)
  const clientHold = await loadClientHold(prisma, tenantId, loan.client.id)

  return (
    <div className="space-y-6 p-4 lg:p-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {loan.contractType !== "LOAN" && <RateCorrectionPanel tenantId={tenantId} loanId={loan.id} status={loan.status} />}
        <Breadcrumbs
          items={[
            { label: "Loans", href: "/loans" },
            { label: `${loan.client.firstName} ${loan.client.lastName}` },
          ]}
        />
        <LoanDocumentActions
          loanId={loan.id}
          showSection129={section129Availability.hasRetrievableIssuedArtifact}
          section129Simulated={section129Availability.latestIssuedSimulated}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <DataPanel
            title="Loan summary"
            description={`Reference ${loan.reference}`}
            variant="raised"
            density="loose"
            actions={
              <LoanSummaryBadges
                status={loan.status}
                applicationId={loan.applicationId}
                agreementSigned={Boolean(loan.application?.agreementSignedAt)}
              />
            }
          >
            {dunningEligibility.eligible && (
              <InfoStrip
                variant="warning"
                className="mb-6"
                actions={
                  <Link href={`/collections/${loan.id}`}>
                    <Button variant="outline" size="sm" className="text-xs">
                      Go to Collections
                    </Button>
                  </Link>
                }
              >
                {loan.daysInArrears} days in arrears - {formatZAR(arrears)} overdue
              </InfoStrip>
            )}

            <div className="mb-6 grid gap-4 sm:grid-cols-3">
              <MetricCard label="Principal" value={formatZAR(loan.principal)} />
              <MetricCard
                // Two different "what's owed" figures sit on this screen: this
                // one is the maturity total, the capture form quotes the s125
                // settlement amount. When they differ, say which is which
                // rather than leaving staff to reconcile two unlabelled
                // numbers — that ambiguity is what this PR set out to remove.
                // While charges are live it is the amount owing today.
                label={
                  charges || settlementAmount === outstanding
                    ? "Balance Remaining"
                    : "Balance at maturity"
                }
                value={formatZAR(outstanding)}
                tone={loan.daysInArrears > 0 ? "warning" : "neutral"}
                className="border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.1)]"
              />
              <MetricCard label="Next payment" value={nextPayment ? formatDate(nextPayment.dueDate) : "-"} />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-[var(--cf-text-muted)]">Repayment progress</span>
                <span className="text-sm font-semibold tabular-nums text-[var(--cf-text)]">{paidPercentage.toFixed(1)}%</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-[var(--cf-surface-strong)]">
                <div
                  className="h-full rounded-full bg-[var(--cf-brand)] transition-all"
                  style={{ width: `${Math.min(paidPercentage, 100)}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <span className="text-[var(--cf-success)]">Paid: <span className="whitespace-nowrap">{formatZAR(cashPaid)}</span></span>
                <span className="text-[var(--cf-text-muted)]">Total: <span className="whitespace-nowrap">{formatZAR(loan.totalRepayable)}</span></span>
              </div>
            </div>
          </DataPanel>

          {payout && <PayoutStatusPanel view={payout} canAct={canManageCharges} />}

          <RepaymentScheduleTable loanId={loan.id} schedule={loan.repaymentSchedule} allowAdminActions={loan.status === "ACTIVE"} />
        </div>

        <div className="space-y-6 lg:col-span-5">
          <DataPanel title="Client profile" description="Borrower identity and affordability context" variant="default" density="loose">
            <div className="mb-6 flex items-center gap-4">
              <div
                className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full text-xl font-bold text-white ring-1 ring-[var(--cf-border-strong)]"
                style={{ backgroundColor: avatarColor }}
              >
                {initials}
              </div>
              <div className="min-w-0">
                <Link href={`/clients/${loan.client.id}`} className="text-lg font-bold text-[var(--cf-text)] hover:text-[var(--cf-brand)]">
                  {loan.client.firstName} {loan.client.lastName}
                </Link>
                <p className="text-sm text-[var(--cf-text-muted)]">Loan {loan.reference}</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm">
                <Phone className="h-4 w-4 text-[var(--cf-text-muted)]" />
                <span className="text-[var(--cf-text-secondary)]">{loan.client.phone}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Mail className="h-4 w-4 text-[var(--cf-text-muted)]" />
                <span className="text-[var(--cf-text-secondary)]">{loan.client.email}</span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <User className="h-4 w-4 text-[var(--cf-text-muted)]" />
                <span className="text-[var(--cf-text-secondary)]">{loan.client.idNumber}</span>
              </div>
              {loan.client.employerName && (
                <div className="flex items-center gap-3 text-sm">
                  <Briefcase className="h-4 w-4 text-[var(--cf-text-muted)]" />
                  <span className="text-[var(--cf-text-secondary)]">{loan.client.employerName}</span>
                </div>
              )}
              {loan.client.monthlyIncome && (
                <div className="flex items-center gap-3 text-sm">
                  <Wallet className="h-4 w-4 text-[var(--cf-text-muted)]" />
                  <span className="text-[var(--cf-text-secondary)]">{formatZAR(loan.client.monthlyIncome)}/month</span>
                </div>
              )}
            </div>
          </DataPanel>

          {(charges || waivable || chargesNotDerived) && (
            <ChargesPanel
              loanId={loan.id}
              charges={charges}
              waivable={waivable}
              settlementAmount={settlementAmount}
              canManage={canManageCharges}
              chargesNotDerived={chargesNotDerived}
            />
          )}

          <DataPanel title="Loan terms" description={loan.product.name} variant="subtle" density="loose">
            <div className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Product</span>
                <span className="text-right font-medium text-[var(--cf-text)]">{loan.product.name}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Term</span>
                <span className="text-right font-medium text-[var(--cf-text)]">{Math.round((new Date(loan.maturityDate).getTime() - new Date(loan.startDate).getTime()) / (30 * 24 * 60 * 60 * 1000))} months</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Rate</span>
                <span className="text-right font-medium text-[var(--cf-text)]">{(loan.interestRatePm * 100).toFixed(1)}% p.m.</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--cf-text-muted)]">Init fee</span>
                <span className="whitespace-nowrap text-right font-medium text-[var(--cf-text)]">{formatZAR(loan.initiationFee)}</span>
              </div>
              <div className="mt-3 flex justify-between gap-4 border-t border-[var(--cf-border-subtle)] pt-3">
                <span className="text-[var(--cf-text-muted)]">Total repayable</span>
                <span className="whitespace-nowrap text-right font-bold text-[var(--cf-brand)]">{formatZAR(loan.totalRepayable)}</span>
              </div>
            </div>
          </DataPanel>

          {/* Payment-capture eligibility, NOT a reporting population — this
              must track lib/loan/apply-payment.ts, or the panel offers a
              capture the API rejects. Do not swap in COLLECTIBLE_STATUSES. */}
          {["ACTIVE", "DEFAULTED"].includes(loan.status) && session?.user?.role && canDo(session.user.role, "capture_payment") && (
            <DataPanel variant="accent" density="loose">
              <SectionHeader
                eyebrow="Servicing"
                title="Record payment"
                description="Capture a repayment against this loan and keep the schedule in sync."
                actions={<CreditCard className="h-5 w-5 text-[var(--cf-brand)]" />}
                className="mb-5"
              />
              <PaymentForm
                loanId={loan.id}
                settlementAmount={settlementAmount}
                contractualBalance={maturityBalance}
                loanStartDay={loan.startDate.toLocaleDateString("en-CA", {
                  timeZone: SAST_TIME_ZONE,
                })}
                // Affordance only — /api/payments re-checks this and 403s.
                canAuthoriseBackdate={
                  session?.user?.role
                    ? hasMinRole(session.user.role, "LOAN_ADMIN")
                    : false
                }
              />
            </DataPanel>
          )}

          <LoanCollectionsPanel tenantId={tenantId} loan={loan} canManage={canManageCharges} />

          <DebtReviewPanel
            loanId={loan.id}
            noticeAt={loan.debtReviewNoticeAt}
            noticeRef={loan.debtReviewNoticeRef}
            siblingNotice={siblingNoticeFrom(clientHold, loan.id)}
            // Affordance only: the route re-checks (debt-review/route.ts).
            canManage={Boolean(session?.user?.role && hasMinRole(session.user.role, "COLLECTIONS_OFFICER") && canDo(session.user.role, "act_on_collections"))}
          />

          <DataPanel title="Payment history" description="Latest receipts posted to this account" variant="default" density="loose">
            {loan.payments.length === 0 ? (
              <p className="text-sm text-[var(--cf-text-muted)]">No payments recorded</p>
            ) : (
              <div className="space-y-3">
                {loan.payments.slice(0, 5).map((payment) => (
                  <div key={payment.id} className="flex items-center justify-between gap-4 border-b border-[var(--cf-border-subtle)] py-2 last:border-0">
                    <div>
                      <p className={`whitespace-nowrap font-semibold ${payment.reversed ? "text-[var(--cf-text-muted)] line-through" : payment.allocationStatus === "ALLOCATED" ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>{formatZAR(payment.amount)}</p>
                      <p className="text-xs text-[var(--cf-text-muted)]">
                        {displayPaymentMethod(payment.paymentMethod, (method) => method.replace("_", " "))} - {formatDate(payment.receivedAt)}
                      </p>
                    </div>
                    {payment.reversed ? (
                      <StatusPill tone="neutral">Reversed</StatusPill>
                    ) : payment.allocationStatus === "UNAPPLIED" ? (
                      <StatusPill tone="warning">Allocation pending</StatusPill>
                    ) : payment.allocationStatus === "REFUNDED" ? (
                      <StatusPill tone="neutral">Refund recorded</StatusPill>
                    ) : (
                      <StatusPill tone="success">Allocated</StatusPill>
                    )}
                  </div>
                ))}
                {loan.payments.length > 5 && (
                  <p className="pt-2 text-center text-xs text-[var(--cf-text-muted)]">
                    + {loan.payments.length - 5} more payments
                  </p>
                )}
              </div>
            )}
          </DataPanel>
        </div>
      </div>

      {/* A sole proprietor's instalment sale is a client's loan but still an asset: court action and recovery apply. */}
      {hasRecoveryPanels(loan) && (
        <AssetLoanRecoveryPanels
          tenantId={tenantId}
          loanId={loan.id}
          userId={session?.user?.id ?? ""}
          canManage={session?.user?.role ? canDo(session.user.role, "manage_asset_finance") : false}
          canDecide={session?.user?.role ? canDo(session.user.role, "decide_asset_finance") : false}
          canRecordPayment={session?.user?.role ? canDo(session.user.role, "record_payment") : false}
          role={session?.user?.role}
        />
      )}

      <DataPanel title="Contact history & notes" variant="default" density="loose">
        <LoanNotes loanId={loan.id} />
      </DataPanel>
    </div>
  )
}
