import { prisma } from "@/lib/prisma"
import { arrearsWithCharges } from "@/lib/loan/charge-labels"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { formatZAR, formatDate } from "@/lib/utils"
import { cashReceivedCents } from "@/lib/payments/waiver"
import { notFound } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { Section129Button } from "@/components/collections/Section129Button"
import { LogContactButton } from "@/components/collections/LogContactButton"
import { PaymentPlanButton } from "@/components/collections/PaymentPlanButton"
import { ManualReminderButton } from "@/components/collections/ManualReminderButton"
import { CollectionDetailTabs } from "@/components/collections/CollectionDetailTabs"
import { ClientWhatsAppButton } from "@/components/clients/ClientWhatsAppButton"
import { CollectionsStagePanel } from "@/components/collections/CollectionsStagePanel"
import { ArrangementTracker } from "@/components/collections/ArrangementTracker"
import { AttorneyReferralCard } from "@/components/collections/AttorneyReferralCard"
import { WriteOffCard } from "@/components/collections/WriteOffCard"
import { WriteOffApprovalCard } from "@/components/collections/WriteOffApprovalCard"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { getSection129IssuanceAvailability } from "@/lib/collections/section129-artifact"
import { latestSection129Failures } from "@/lib/collections/section129-failures"
import { hasClientBorrower } from "@/lib/borrower"
import { loadClientHold, section129ReasonFrom, staffRefusalFrom } from "@/lib/collections/client-holds"
import { EntityBorrowerNotice } from "@/components/loans/EntityBorrowerNotice"

async function getLoanDetail(loanId: string, tenantId: string) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId, tenantId },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, phone: true, whatsapp: true, email: true, idNumber: true } },
      entity: { select: { legalName: true } },
      product: { select: { name: true, productType: true } },
      notes: { orderBy: { createdAt: "desc" } },
      repaymentSchedule: { orderBy: { installmentNo: "asc" } },
      paymentPlan: true,
      payments: {
        where: { reversed: false, allocationStatus: "ALLOCATED" },
        // The date the row displays and the promise window buckets on.
        orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  })
  return loan
}

export default async function CollectionDetailPage({ params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params
  const tenantId = await getStaffTenantId()
  const loan = await getLoanDetail(loanId, tenantId)
  const chargesLive = await chargesLiveForTenant(prisma, tenantId)
  if (!loan) notFound()
  if (!hasClientBorrower(loan)) {
    return (
      <EntityBorrowerNotice
        crumbs={[{ label: "Collections", href: "/collections" }]}
        reference={loan.reference}
        legalName={loan.entity?.legalName ?? null}
      />
    )
  }

  const clientName = `${loan.client.firstName} ${loan.client.lastName}`
  const writeOffPending = loan.status === "PENDING_WRITE_OFF"
  const dunningEligibility = evaluateCollectionsEligibility(loan, "DUNNING")
  const section129Eligibility = evaluateCollectionsEligibility(loan, "SECTION_129")

  // Fetch arrangement + referral + (if pending) the current officer + requester
  const [arrangement, referral, session, requester, section129Availability, section129Failures, clientHold] = await Promise.all([
    prisma.paymentArrangement.findFirst({ where: { loanId, tenantId } }),
    prisma.attorneyReferral.findUnique({ where: { loanId } }),
    writeOffPending ? auth() : Promise.resolve(null),
    writeOffPending && loan.writeOffRequestedById
      ? prisma.user.findUnique({ where: { id: loan.writeOffRequestedById }, select: { name: true, email: true } })
      : Promise.resolve(null),
    getSection129IssuanceAvailability(tenantId, loan.id),
    latestSection129Failures(tenantId, [loan.id]),
    // Read once: the banner, the S.129 button, the reminder button and the stage panel all follow from it.
    loadClientHold(prisma, tenantId, loan.client.id),
  ])
  const messageRefusal = staffRefusalFrom(clientHold)
  const debtReviewBlock = section129ReasonFrom(clientHold)
  const section129Failure = section129Failures.get(loan.id) ?? null
  const section129Enabled = section129Eligibility.eligible && section129Availability.canReserve && !debtReviewBlock
  // Time alone lifts the DPD threshold and the re-issue cooldown; NON_NCA, status and an active issuance do not.
  const section129BlockTemporary = debtReviewBlock ? false : section129Eligibility.reason
    ? section129Eligibility.temporary
    : section129Availability.blockedBy !== "ACTIVE_ISSUANCE" && Boolean(section129Availability.cooldownEndsAt)
  // One reason for the disabled button's tooltip and the stage panel's hint.
  const section129BlockReason = section129Enabled ? null : (debtReviewBlock ? `Cannot issue a Section 129 notice: ${debtReviewBlock}.` : section129Eligibility.reason
    ?? (section129Availability.blockedBy === "ACTIVE_ISSUANCE"
      ? `An issuance is already ${section129Availability.activeLifecycle?.toLowerCase().replaceAll("_", " ") ?? "in progress"}.`
      : section129Availability.cooldownEndsAt
        ? `A new notice can be reserved after ${formatDate(section129Availability.cooldownEndsAt)}.`
        : "Section 129 issuance is currently unavailable."))

  // Serialize for client components
  const serializedNotes = JSON.parse(JSON.stringify(loan.notes))
  const serializedSchedule = JSON.parse(JSON.stringify(loan.repaymentSchedule))
  const serializedPayments = JSON.parse(JSON.stringify(loan.payments))

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Collections", href: "/collections" },
          { label: clientName },
        ]}
      />

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            <Link href={`/clients/${loan.client.id}`} className="hover:underline">{clientName}</Link>
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            <span className="font-mono">{loan.reference}</span> · {loan.product.name}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-center">
            <p className="text-xs text-gray-400">DPD</p>
            <p className="text-2xl font-bold text-red-600">{loan.daysInArrears}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-gray-400">Arrears</p>
            <p className="whitespace-nowrap text-xl font-bold text-gray-900">{formatZAR(arrearsWithCharges(loan, chargesLive))}</p>
          </div>
        </div>
      </div>

      {/* Loan summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Principal", value: formatZAR(loan.principal) },
          { label: "Outstanding", value: formatZAR(loan.outstandingPrincipal) },
          // Cash received; Loan.totalPaid is only the share applied to the instalments.
          { label: "Total Paid", value: formatZAR(cashReceivedCents(loan.payments)) },
          { label: "Next Due", value: loan.nextPaymentDate ? formatDate(loan.nextPaymentDate) : "N/A" },
        ].map((c) => (
          <div key={c.label} className="bg-white rounded-lg border border-gray-100 p-3">
            <p className="text-xs text-gray-400">{c.label}</p>
            <p className="whitespace-nowrap text-sm font-semibold text-gray-900">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Actions bar — hidden once the loan is written off; WriteOffCard below
          already states no further collections activity should be initiated. */}
      {loan.status === "WRITTEN_OFF" ? (
        <div className="mb-6 p-4 bg-gray-50 rounded-lg text-[12px] text-gray-500">
          This loan has been permanently written off. No further collections activity should be initiated.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-6 p-4 bg-gray-50 rounded-lg">
          <Link
            href={`/loans/${loan.id}`}
            className="px-3 py-1.5 rounded text-[12px] font-semibold border border-green-300 text-green-700 bg-green-50 hover:bg-green-100 transition-colors"
          >
            Record Payment
          </Link>
          <LogContactButton loanId={loan.id} clientName={clientName} />
          {section129Availability.hasRetrievableIssuedArtifact && (
            <a
              href={`/api/loans/${loan.id}/section129-pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded text-[12px] font-semibold border border-red-300 text-red-700 bg-red-50 hover:bg-red-100"
            >
              {section129Availability.latestIssuedSimulated ? "View simulated S.129 (not sent)" : "View Issued S.129"}
            </a>
          )}
          {section129Enabled ? (
            <Section129Button loanId={loan.id} loanRef={loan.reference} clientName={clientName} />
          ) : (
            <button
              type="button"
              disabled
              title={section129BlockReason ?? undefined}
              className="px-3 py-1.5 rounded text-[12px] font-semibold border border-gray-200 text-gray-400 bg-gray-100 cursor-not-allowed"
            >
              S.129 unavailable
            </button>
          )}
          {dunningEligibility.eligible && (
            <>
              <PaymentPlanButton
                loanId={loan.id}
                clientName={clientName}
                arrearsAmount={arrearsWithCharges(loan, chargesLive)}
                arrearsAmountDisplay={formatZAR(arrearsWithCharges(loan, chargesLive))}
              />
              {/* The route refuses a staff message to a deceased or debt-review client; do not offer it. */}
              {!messageRefusal && (
                <ManualReminderButton loanId={loan.id} clientName={clientName} clientPhone={loan.client.phone} loanReference={loan.reference} />
              )}
            </>
          )}
          {/* The composer refuses a deceased client's Contact (blocked), so do not offer it. */}
          {dunningEligibility.eligible && !clientHold?.deceased && (
            <ClientWhatsAppButton
              clientId={loan.client.id}
              clientName={clientName}
              phone={loan.client.whatsapp ?? loan.client.phone}
            />
          )}
        </div>
      )}

      {clientHold && messageRefusal && (
        <div role="status" className="mb-6 rounded-lg border border-[var(--cf-warning)] p-4 text-[13px] text-[var(--cf-warning)]">
          {clientHold.deceased ? (
            <p className="font-semibold">Automated reminders and staff messages are paused: a death is recorded for this client.</p>
          ) : (
            <>
              <p className="font-semibold">Automated reminders and staff messages are paused: {messageRefusal}.</p>
              {clientHold.debtReview && (
                <p className="mt-1">
                  <Link href={`/loans/${clientHold.debtReview.loanId}`} className="underline">
                    Open loan {clientHold.debtReview.loanReference}
                  </Link>{" "}
                  to see or clear the debt-review notice.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {section129Failure && loan.status !== "WRITTEN_OFF" && (
        <div role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-[13px] text-red-800">
          <p className="font-semibold">The last Section 129 notice was not sent ({formatDate(section129Failure.failedAt)})</p>
          <p className="mt-1">{section129Failure.reason}</p>
        </div>
      )}

      {/* Stage panel + Tabbed content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <CollectionDetailTabs
            notes={serializedNotes}
            schedule={serializedSchedule}
            payments={serializedPayments}
          />
        </div>
        <div className="space-y-4">
          <CollectionsStagePanel
            loanId={loan.id}
            currentStage={(loan.collectionsStage ?? "NONE") as "NONE" | "SOFT_REMINDER" | "FORMAL_REMINDER" | "SECTION_129_SENT" | "PAYMENT_ARRANGEMENT" | "ATTORNEY_REFERRED" | "WRITTEN_OFF"}
            daysInArrears={loan.daysInArrears}
            arrearsAmount={arrearsWithCharges(loan, chargesLive)}
            writeOffPending={writeOffPending}
            section129Unavailable={section129BlockReason ? { reason: section129BlockReason, temporary: section129BlockTemporary } : undefined}
            readOnlyReason={dunningEligibility.eligible ? undefined : dunningEligibility.reason ?? "Collections actions are unavailable"}
            // Only the reminder moves (they auto-send a WhatsApp); arrangement and attorney stay usable.
            reminderHoldReason={messageRefusal ?? undefined}
            existingArrangement={arrangement ? {
              agreedAmount: arrangement.agreedAmount,
              frequency: arrangement.frequency,
              startDate: arrangement.startDate.toISOString(),
              endDate: arrangement.endDate.toISOString(),
              notes: arrangement.notes ?? undefined,
            } : null}
            existingReferral={referral ? {
              firmName: referral.firmName,
              contactPerson: referral.contactPerson ?? undefined,
              contactPhone: referral.contactPhone ?? undefined,
              contactEmail: referral.contactEmail ?? undefined,
              matterNumber: referral.matterNumber ?? undefined,
              notes: referral.notes ?? undefined,
            } : null}
          />
          {dunningEligibility.eligible && <ArrangementTracker loanId={loan.id} />}
          {dunningEligibility.eligible && <AttorneyReferralCard loanId={loan.id} />}
          {writeOffPending && loan.writeOffReason && (
            <WriteOffApprovalCard
              loanId={loan.id}
              reason={loan.writeOffReason}
              requestedByName={requester?.name ?? requester?.email ?? "Unknown"}
              isRequester={session?.user?.id === loan.writeOffRequestedById}
              outstandingPrincipal={loan.outstandingPrincipal}
            />
          )}
          {loan.writeOffAt && loan.writeOffReason && (
            <WriteOffCard
              writeOffAt={loan.writeOffAt.toISOString()}
              writeOffReason={loan.writeOffReason}
              approvedByName={loan.writeOffApprovedById ?? null}
              outstandingAtWriteOff={loan.outstandingPrincipal}
            />
          )}
        </div>
      </div>
    </div>
  )
}
