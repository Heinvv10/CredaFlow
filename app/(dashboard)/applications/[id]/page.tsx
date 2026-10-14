import { notFound } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { prisma } from "@/lib/prisma"
import { formatZAR, formatDate, formatTermDays } from "@/lib/utils"
import { decisionAuditItem } from "@/lib/applications/decision-audit-item"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { ActionRail } from "@/components/app-shell/ActionRail"
import { CaseFileLayout } from "@/components/app-shell/CaseFileLayout"
import { MetricCard } from "@/components/app-shell/MetricCard"
import { StatusPill } from "@/components/app-shell/StatusPill"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { calculateLoan } from "@/lib/loan-calculator"
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react"
import { AgreementSection } from "@/components/applications/AgreementSection"
import { PipelineStepper } from "@/components/applications/PipelineStepper"
import { AffordabilityCapture } from "@/components/applications/AffordabilityCapture"
import { CreditBureauCheckPanel } from "@/components/applications/CreditBureauCheckPanel"
import { ComplianceCapture } from "@/components/applications/ComplianceCapture"
import { DisburseForm } from "@/components/applications/DisburseForm"
import { CreditChecksPanel } from "@/components/applications/CreditChecksPanel"
import { StatementInsightsPanel } from "@/components/applications/StatementInsightsPanel"
import { ApplicationApprovePanel } from "@/components/applications/ApplicationApprovePanel"
import { canCancelApplication, showDebtEvidenceBlocker } from "@/lib/applications/decision-kind"
import { ApplicationCancelButton } from "@/components/applications/ApplicationCancelButton"
import { ApplicationStartReviewButton } from "@/components/applications/ApplicationStartReviewButton"
import { ApplicationReturnToDraftButton } from "@/components/applications/ApplicationReturnToDraftButton"
import { ApplicationSubmitButton } from "@/components/applications/ApplicationSubmitButton"
import { ApplicationReturnToReviewButton } from "@/components/applications/ApplicationReturnToReviewButton"
import { auth } from "@/lib/auth"
import { canDo, hasMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import {
  readCompositeKycState,
  type CoreDocumentGapState,
  type ClientKycExistingState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import type { BiometricSubjectClient } from "@/lib/kyc/biometric-evidence"
import { deriveKycBlockers, kycGateStage } from "@/lib/kyc/kyc-blockers"
import { getStatusTone } from "@/lib/status-style"
import { MessageClientButton } from "@/components/messaging/MessageClientButton"
import { ContactChannelIcons } from "@/components/messaging/ContactChannelIcons"
import type { Channel } from "@/components/messaging/ChannelPicker"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { DOC_TYPE_LABELS } from "@/lib/document-types"
import { AvsStatusCard } from "@/components/applications/AvsStatusCard"
import { SelfieLinkSection } from "@/components/applications/SelfieLinkSection"
import { isSmsChannelEnabled } from "@/lib/messaging/sms-channel"
import { maskDestination } from "@/lib/compliance/pasq-link-token.server"
import { annualisedInterestRate, termInterestPercent } from "@/lib/loan/annualised-rate"
import { avsCheckMatchesSubject } from "@/lib/compliance/avs-subject"
import { resolveBureauDisplay } from "@/lib/compliance/bureau-display"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import { unresolvedNonBiometricDocumentMismatchWhere } from "@/lib/kyc/document-mismatches"
import { verifyAppliedCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { resolveAffordabilityDisplayInputs } from "@/lib/affordability/display"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import {
  affordabilityContractEvidenceIsIntact,
  affordabilityDecisionSnapshotIsIntact,
  latestAffordabilitySnapshot,
  loanCalculationFromEvidence,
  InvalidAffordabilityDebtError,
  normaliseAffordabilityDebts,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  totalAffordabilityDebt,
} from "@/lib/affordability/snapshot"
import { hasClientBorrower } from "@/lib/borrower"
import { EntityBorrowerNotice } from "@/components/loans/EntityBorrowerNotice"

const KYC_GAP_LABELS: Record<CoreDocumentGapState, string> = {
  not_uploaded: "not uploaded yet",
  awaiting_verification: "uploaded, awaiting verification",
  // Says what is certain. Whether the note is a reviewer's refusal or the
  // system re-flagging a statement after a bank-detail change, the action is
  // the same: read it. Claiming "rejected, re-upload" is false for the latter.
  flagged: "flagged — open the document to read the note",
  rejected: "rejected by a reviewer — a new upload is required",
}

async function getApplication(id: string, tenantId: string) {
  return prisma.loanApplication.findUnique({
    where: { id, tenantId },
    include: {
      client: { include: { debtObligations: true } },
      entity: { select: { legalName: true } },
      product: true,
      assignedTo: { select: { name: true, email: true } },
      approvedBy: { select: { name: true, email: true } },
      loan: true,
    },
  })
}

async function getBureauCheck(
  applicationId: string,
  tenantId: string,
  reviewGeneration: string | null,
) {
  if (!reviewGeneration) return null
  return prisma.complianceRecord.findFirst({
    where: {
      tenantId,
      type: "CREDIT_BUREAU_CHECK",
      referenceId: applicationId,
      data: { path: ["reviewGeneration"], equals: reviewGeneration },
    },
    orderBy: { createdAt: "desc" },
  })
}

async function getBureauObligations(
  applicationId: string,
  tenantId: string,
  reviewGeneration: string | null,
) {
  if (!reviewGeneration) return null
  const check = await prisma.creditBureauCheck.findFirst({
    where: { tenantId, applicationId, reviewGeneration, ok: true },
    orderBy: { createdAt: "desc" },
    select: { obligations: true },
  })
  const obligs = check?.obligations as { totalMonthly?: number } | null
  return {
    totalMonthly: obligs?.totalMonthly ?? null,
    simulated: isSimulatedBureauCheck(check?.obligations),
  }
}

async function getDocumentMismatches(clientId: string, tenantId: string) {
  return prisma.clientDocument.findMany({
    where: unresolvedNonBiometricDocumentMismatchWhere({
      tenantId,
      clientId,
    }),
    select: { id: true, docType: true, fileName: true },
  })
}

/**
 * The rail must state the same gate the review/decide/disburse routes enforce.
 * A local core-document scan is not that gate: it cannot see a failed biometric
 * attempt or an active manual rejection, so it renders "No blockers" on cases
 * the API then 422s. Read the one composite evaluator instead.
 * Which statuses this must run for lives in kycGateStage — see lib/kyc/kyc-blockers.
 */
async function getReviewKycGate(
  client: BiometricSubjectClient & ClientKycExistingState,
  tenantId: string,
) {
  return readCompositeKycState(prisma as unknown as CompositeKycReader, {
    tenantId,
    clientId: client.id,
    subject: client,
    existing: client,
    preserveVerifiedProvenance: true,
  })
}

type LatestAvsCheck = {
  clientId: string
  subjectFingerprint: string | null
  passed: boolean
  accountNumber: string
  createdAt: Date
}

async function getLatestAvsCheck(applicationId: string, clientId: string, tenantId: string): Promise<LatestAvsCheck | null> {
  const reader = prisma.avsCheck as unknown as {
    findFirst(args: unknown): Promise<LatestAvsCheck | null>
  }
  return reader.findFirst({
    where: { tenantId, clientId, applicationId },
    orderBy: { createdAt: "desc" },
    select: {
      clientId: true,
      subjectFingerprint: true,
      passed: true,
      accountNumber: true,
      createdAt: true,
    },
  })
}

// Phase 7 AVS surface gate — dark behind TenantConfig.collectionsEngineEnabled.
// When off, the AvsStatusCard must not render AND the latestAvsCheck query
// must not run, so merge-day (flag-off) behavior stays byte-identical.
async function getCollectionsEngineEnabled(tenantId: string): Promise<boolean> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { collectionsEngineEnabled: true },
  })
  return config?.collectionsEngineEnabled ?? false
}

interface PageProps { params: Promise<{ id: string }> }

export default async function ApplicationDetailPage({ params }: PageProps) {
  const { id } = await params
  const tenantId = await getStaffTenantId()
  const [application, session, collectionsEngineEnabled] = await Promise.all([
    getApplication(id, tenantId),
    auth(),
    getCollectionsEngineEnabled(tenantId),
  ])
  if (!application) notFound()
  if (!hasClientBorrower(application)) {
    return (
      <EntityBorrowerNotice
        crumbs={[{ label: "Applications", href: "/applications" }]}
        reference={application.reference}
        legalName={application.entity?.legalName ?? null}
      />
    )
  }
  const userRole = session?.user?.role ?? "READONLY"
  const canDisburse = canDo(userRole, "disburse_loan")
  const canApprove = canDo(userRole, "approve_loan")
  // The checks API (GET /api/applications/[id]/checks) needs CREDIT_OFFICER.
  const canReadChecks = hasMinRole(userRole, "CREDIT_OFFICER")
  const checksUndecided = application.status === "DRAFT" || application.status === "SUBMITTED" || application.status === "UNDER_REVIEW"
  const openChecks = await prisma.applicationCheckFlag.count({
    where: { tenantId, applicationId: application.id, status: "OPEN" },
  })
  const agreementSignedDisplayMethod =
    application.agreementSignedMethod === "branch"
    && application.agreementSignatureData?.startsWith("signed-packet-v1:")
      ? "returned PDF"
      : application.agreementSignedMethod

  const [
    docMismatches,
    bureauCheck,
    bureauObligationsRaw,
    kycGate,
    cannedReplies,
    latestAvsCheck,
    latestSelfieToken,
  ] = await Promise.all([
    getDocumentMismatches(application.clientId, tenantId),
    getBureauCheck(application.id, tenantId, application.bureauReviewGeneration),
    getBureauObligations(application.id, tenantId, application.bureauReviewGeneration),
    // Every status with a composite-KYC gate still ahead of it, not just the
    // one being reviewed. The cached client.kycStatus is a projection of this
    // evidence, so it cannot stand in for evaluating it.
    kycGateStage(application.status)
      ? getReviewKycGate(application.client, tenantId)
      : Promise.resolve(null),
    listCannedReplies(tenantId),
    collectionsEngineEnabled
      ? getLatestAvsCheck(application.id, application.clientId, tenantId)
      : Promise.resolve(null),
    prisma.selfieCaptureToken.findFirst({
      where: { tenantId, applicationId: application.id },
      orderBy: { createdAt: "desc" },
      select: { channel: true, sentTo: true, expiresAt: true, usedAt: true },
    }),
  ])
  // Masked here rather than in the component: the raw destination must not
  // cross into a client bundle at all.
  const latestSelfieTokenView = latestSelfieToken
    ? {
        channel: latestSelfieToken.channel,
        sentTo: maskDestination(latestSelfieToken.sentTo),
        expiresAt: latestSelfieToken.expiresAt.toISOString(),
        usedAt: latestSelfieToken.usedAt?.toISOString() ?? null,
      }
    : null
  const cannedRepliesSafe = cannedReplies.map((c) => ({ id: c.id, title: c.title, body: c.body }))
  const kycStage = kycGateStage(application.status)
  const kycBlockers = kycStage ? deriveKycBlockers(kycGate, kycStage) : []
  // The agreement route enforces the strict ("disbursement") grade whatever
  // the application's status is, so the packet panel must be told the strict
  // result — not the stage-appropriate one the rest of the page shows. At
  // APPROVED the two coincide; before it they do not, and the panel would
  // otherwise offer to mint a quotation the agreement call will refuse.
  const signingKycBlockers = deriveKycBlockers(kycGate, "disbursement")
  // The banner tells the client which documents to send, so show it only when
  // documents are what actually stands in the way — a manual rejection is
  // cleared by a KYC decision, never by re-uploading.
  // Staff need to know WHICH action each document needs, not just that it is
  // outstanding: chase the client, review it, or tell them it was refused.
  const kycDocumentGaps = kycGate?.coreDocumentGaps ?? []
  const kycMissingDocs = kycBlockers.some((b) => b.kind === "missing_documents")
    ? kycGate?.missingCoreDocuments ?? null
    : null

  const liveLoanCalc = calculateLoan({
    principal: application.appliedAmount,
    termDays: application.appliedTermDays,
    interestRatePm: application.product.interestRatePm,
    productType: application.product.productType,
    interestModel: application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL",
    initiationFeeModel: application.product.initiationFeeModel,
    initiationFeePct: application.product.initiationFeePct,
    initiationFeeMax: application.product.initiationFeeMax,
    monthlyServiceFee: application.product.monthlyServiceFee,
    initiationFeePayment: application.initiationFeePayment,
  })
  const affordabilityLocked = !["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(application.status)
  const affordabilityStore = readAffordabilitySnapshotStore(application.affordabilityResult)
  const approvalSnapshotRequired = ["APPROVED", "DISBURSED"].includes(application.status)
  const affordabilitySnapshotCandidate = approvalSnapshotRequired
    ? affordabilityStore.approval ?? null
    : latestAffordabilitySnapshot(application.affordabilityResult)
  // Snapshot rows pre-dating calculator evidence (or malformed JSON) must
  // fail closed in the decided UI. Do not dereference them and crash, and do
  // not silently substitute today's mutable product pricing.
  const affordabilitySnapshot = affordabilitySnapshotCandidate &&
    affordabilityDecisionSnapshotIsIntact(affordabilitySnapshotCandidate)
    ? affordabilitySnapshotCandidate
    : null
  const contractEvidence = affordabilitySnapshot?.stage === "APPROVAL" &&
    affordabilityStore.contract &&
    affordabilityContractEvidenceIsIntact(
      affordabilityStore.contract,
      affordabilitySnapshot,
    )
    ? affordabilityStore.contract
    : null
  const loanCalc = affordabilityLocked && affordabilitySnapshot
    ? loanCalculationFromEvidence(
        contractEvidence?.calculator ?? affordabilitySnapshot.calculator,
      )
    : liveLoanCalc
  const displayedPrincipal = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.principalCents
    : application.appliedAmount
  const displayedTermDays = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.termDays
    : application.appliedTermDays
  const displayedInterestRatePm = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.interestRatePm
    : application.product.interestRatePm
  // A monthly rate has no meaning apart from the model it accrues under, so the
  // two must come from ONE source. Taking the rate from the snapshot and the
  // model from the live product row yields an annualised figure describing a
  // loan that does not exist.
  const displayedInterestModel = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.interestModel
    : (application.product.interestModel as "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL")
  const decisionPricingUnavailable = affordabilityLocked && !affordabilitySnapshot
  const displayedAffordabilityInputs = resolveAffordabilityDisplayInputs({
    locked: affordabilityLocked,
    snapshot: affordabilitySnapshot,
    liveMonthlyIncomeCents: application.client.monthlyIncome,
    liveMonthlyExpensesCents: application.client.monthlyExpenses,
    liveProposedInstalmentCents: loanCalc.monthlyInstalment,
  })
  const displayedMonthlyIncome = displayedAffordabilityInputs.monthlyIncomeCents
  const displayedMonthlyExpenses = displayedAffordabilityInputs.monthlyExpensesCents
  const displayedProposedInstalment = displayedAffordabilityInputs.proposedInstalmentCents
  let applicationDebtEvidenceInvalid = false
  let applicationDebtRows: {
    sourceId: string | null
    creditor: string
    type: string
    monthlyInstalment: number
    balance: number
    notes: string | null
  }[] = []
  try {
    const normalisedApplicationDebts = normaliseAffordabilityDebts(
      readAffordabilityDebtInputs(application.existingDebtObligations),
    )
    // The aggregate is itself persisted in Prisma Int fields later in the
    // lifecycle. Individually valid rows that overflow that aggregate are
    // corrupt evidence and must not produce a preview grade.
    totalAffordabilityDebt(normalisedApplicationDebts)
    applicationDebtRows = normalisedApplicationDebts.map((debt) => ({
      sourceId: debt.sourceId,
      creditor: debt.provider,
      type: debt.type,
      monthlyInstalment: debt.monthlyInstalmentCents,
      balance: debt.balanceCents,
      notes: debt.notes,
    }))
  } catch (error) {
    if (!(error instanceof InvalidAffordabilityDebtError)) throw error
    applicationDebtEvidenceInvalid = true
  }
  const displayedDebtRows = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.debts.application.map((debt) => ({
        sourceId: debt.sourceId,
        creditor: debt.provider,
        type: debt.type,
        monthlyInstalment: debt.monthlyInstalmentCents,
        balance: debt.balanceCents,
        notes: debt.notes,
      }))
    : applicationDebtRows
  let clientDebtTotal = 0
  let clientDebtEvidenceInvalid = false
  try {
    clientDebtTotal = totalAffordabilityDebt(
      normaliseAffordabilityDebts(application.client.debtObligations),
    )
  } catch (error) {
    if (!(error instanceof InvalidAffordabilityDebtError)) throw error
    clientDebtEvidenceInvalid = true
  }

  const selfDeclaredDebt = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.declaredDebtCents
    : application.totalExistingDebt || 0
  const bureauDebt = affordabilityLocked && affordabilitySnapshot
    ? affordabilitySnapshot.inputs.bureauObligationsCents
    : bureauObligationsRaw?.totalMonthly ?? null
  const bureauDisplay = resolveBureauDisplay({
    applicationStatus: application.status,
    approvalSnapshot: affordabilitySnapshot,
    complianceRecord: bureauCheck,
    simulated: bureauObligationsRaw?.simulated ?? false,
  })
  // Model-aware and NOMINAL for every product (lib/loan/annualised-rate).
  // Both operands come from the approval snapshot once locked, so an approved
  // application keeps quoting the rate AND the model it was approved on, not a
  // since-changed product row.
  const annualRate = annualisedInterestRate({
    interestRatePm: displayedInterestRatePm,
    interestModel: displayedInterestModel,
  })
  const termInterestPct = termInterestPercent({
    principal: application.appliedAmount,
    totalInterest: loanCalc.totalInterest,
  })
  const fullName = `${application.client.firstName} ${application.client.lastName}`
  const missingDocLabels = (kycMissingDocs ?? []).map((d) => DOC_TYPE_LABELS[d] ?? d.replace(/_/g, " "))
  const requestDocsQuickActions: { label: string; channel: Channel; prefill: { body: string } }[] =
    missingDocLabels.length > 0
      ? [{
          label: "Request missing documents",
          channel: "WHATSAPP",
          prefill: {
            body: `Hi ${application.client.firstName}, to proceed with your application we still need: ${missingDocLabels.join(", ")}. Please reply with these documents so we can continue. Thank you.`,
          },
        }]
      : []
  const statusLabel = application.status.replace(/_/g, " ")
  const agreementReady = !!application.agreementSignedAt && !!application.agreementCountersignedAt
  const mandateReady = !!application.debitMandateSignedAt
  const mandateRequired = application.repaymentMethod !== "EFT"
  const repaymentSetupReady = !mandateRequired || mandateReady
  // /decide refuses approval without this, but its 422 carries no field the
  // approve panel branches on, so staff previously met a red message with no
  // action attached to it. Say it on the rail instead, before they click.
  const creditLifeDisclosure = verifyAppliedCreditLifeDisclosure(application)
  const currentStage = getApplicationStage(application.status, {
    kycVerified: application.client.kycStatus === "VERIFIED",
    affordabilityDone: !!application.affordabilityNDI,
    agreementSigned: agreementReady,
  })
  const blockers = [
    ...(docMismatches.length > 0
      ? [{ label: `${docMismatches.length} document mismatch${docMismatches.length === 1 ? "" : "es"}`, detail: "Resolve document validation issues before final approval.", tone: "warning" as const }]
      : []),
    ...kycBlockers,
    ...(!application.affordabilityNDI && ["UNDER_REVIEW", "SUBMITTED"].includes(application.status)
      ? [{ label: "Affordability pending", detail: "Capture NDI and repayment suitability evidence.", tone: "warning" as const }]
      : []),
    ...(showDebtEvidenceBlocker(application, applicationDebtEvidenceInvalid)
      ? [{ label: "Debt evidence invalid", detail: "Re-enter every credit obligation before reassessment. Approval and payout remain blocked.", tone: "danger" as const }]
      : []),
    ...(application.status === "UNDER_REVIEW" && !creditLifeDisclosure.ok
      ? [{ label: "Credit-life election missing", detail: "Return this application to draft and recapture the consumer election before generating the PASQ.", tone: "danger" as const }]
      : []),
    ...(application.status === "APPROVED" && agreementReady && mandateRequired && !mandateReady
      ? [{ label: "Debit mandate pending", detail: "The customer must confirm verified banking and sign the exact debit authority before payout.", tone: "danger" as const }]
      : []),
  ]
  const decisionItem = decisionAuditItem(application)
  const auditItems = [
    { label: `Created ${formatDate(application.createdAt)}`, detail: application.reference, tone: "neutral" as const },
    ...(application.assignedTo ? [{ label: "Assigned advisor", detail: application.assignedTo.name ?? application.assignedTo.email, tone: "info" as const }] : []),
    ...(decisionItem ? [decisionItem] : []),
    ...(application.agreementSignedAt ? [{ label: `Signed ${formatDate(application.agreementSignedAt)}`, detail: agreementSignedDisplayMethod ?? "Agreement accepted", tone: "success" as const }] : []),
    ...(application.agreementCountersignedAt ? [{ label: `Provider countersigned ${formatDate(application.agreementCountersignedAt)}`, detail: application.agreementCountersignedByName ?? "Authorised representative", tone: "success" as const }] : []),
    ...(application.debitMandateSignedAt ? [{ label: `Debit mandate signed ${formatDate(application.debitMandateSignedAt)}`, detail: "Customer portal signature recorded", tone: "success" as const }] : []),
    ...(application.agreementSignedAt && !application.agreementCountersignedAt
      ? [{ label: "Provider countersignature pending", detail: "Disbursement remains blocked until an authorised representative countersigns the exact agreement.", tone: "warning" as const }]
      : []),
  ]
  // Pre-empt the one DRAFT→SUBMITTED refusal the walkthrough hit — the
  // credit-life gate — reusing the SAME verified-disclosure result computed
  // above for the rail blocker, so the two staff surfaces cannot disagree.
  // The PATCH handler's other refusals (evidence/MLE/expense checks) still
  // apply server-side; the button surfaces their exact error text after the
  // click rather than pre-computing the full affordability snapshot here.
  const submitBlockedReason =
    application.status === "DRAFT" && !creditLifeDisclosure.ok
      ? "Open Edit draft and record the client's credit-life election and exact-premium disclosure first."
      : null
  const primaryActions = (
    <>
      {application.status === "DRAFT" && (
        <>
          <Button asChild variant="outline" className="w-full">
            <Link href={`/applications/new?id=${application.id}`}>Edit draft</Link>
          </Button>
          <ApplicationSubmitButton
            applicationId={application.id}
            blockedReason={submitBlockedReason}
          />
        </>
      )}
      {application.status === "SUBMITTED" && (
        <ApplicationStartReviewButton applicationId={application.id} />
      )}
      {application.status === "UNDER_REVIEW" && (
        <>
          <ApplicationApprovePanel applicationId={application.id} canApprove={canApprove} openChecks={openChecks} />
          <ApplicationStartReviewButton applicationId={application.id} mode="retry" />
          <ApplicationReturnToDraftButton applicationId={application.id} />
        </>
      )}
      {application.status === "APPROVED" && !application.loan && !application.agreementSignedAt && (
        <StatusPill tone="warning" className="w-full justify-center rounded-md py-2">
          Awaiting agreement
        </StatusPill>
      )}
      {application.status === "APPROVED" && !application.loan && application.agreementSignedAt && !application.agreementCountersignedAt && (
        <StatusPill tone="warning" className="w-full justify-center rounded-md py-2">
          Awaiting provider countersignature
        </StatusPill>
      )}
      {application.status === "APPROVED" && !application.loan && agreementReady && mandateRequired && !mandateReady && (
        <StatusPill tone="warning" className="w-full justify-center rounded-md py-2">
          Awaiting customer debit mandate
        </StatusPill>
      )}
      {application.status === "APPROVED" && !application.loan && canApprove && (
        <ApplicationReturnToReviewButton applicationId={application.id} />
      )}
      {application.status === "DISBURSED" && application.loan && (
        <Button asChild className="w-full">
          <Link href={`/loans/${application.loan.id}`}>Open Loan {application.loan.reference}</Link>
        </Button>
      )}
    </>
  )
  const secondaryActions = (
    <>
      {canCancelApplication(application) && (
        <ApplicationCancelButton applicationId={application.id} />
      )}
      <MessageClientButton
        clientId={application.clientId}
        clientName={fullName}
        cannedReplies={cannedRepliesSafe}
        quickActions={requestDocsQuickActions}
        fullWidth
      />
      <Button asChild variant="outline" className="w-full">
        <Link href={`/clients/${application.clientId}`}>View Client Record</Link>
      </Button>
      <Button asChild variant="ghost" className="w-full">
        <Link href={`/clients/${application.clientId}?tab=documents`}>Review Documents</Link>
      </Button>
    </>
  )

  return (
    <>
      <Header
        title={`Application ${application.reference}`}
        subtitle={`${application.client.firstName} ${application.client.lastName}`}
        breadcrumbs={[
          { label: "Applications", href: "/applications" },
          { label: fullName },
        ]}
      />
      <div className="p-4 lg:p-8 space-y-6">
        <CaseFileLayout
          context={
            <div className="space-y-4">
              <DataPanel variant="raised" density="compact">
                <div className="space-y-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Case file</p>
                    <h2 className="mt-2 text-2xl font-semibold leading-tight text-[var(--cf-text)]">{fullName}</h2>
                    <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{application.reference} · {application.product.name}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={getStatusTone(application.status)}>{statusLabel}</Badge>
                    {application.agreementType && <Badge variant="info">{application.agreementType}</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <MetricCard label="Amount" value={formatZAR(displayedPrincipal)} detail={formatTermDays(displayedTermDays)} className="min-w-[170px] flex-1 p-3" />
                    <MetricCard label="Total" value={decisionPricingUnavailable ? "Evidence unavailable" : formatZAR(loanCalc.totalRepayable)} detail="Repayable" tone="warning" className="min-w-[170px] flex-1 p-3" />
                  </div>
                  <div className="space-y-2 text-sm text-[var(--cf-text-secondary)]">
                    <p><span className="text-[var(--cf-text-muted)]">ID:</span> {application.client.idNumber}</p>
                    <p><span className="text-[var(--cf-text-muted)]">Email:</span> {application.client.email}</p>
                    <p className="flex items-center gap-2">
                      <span><span className="text-[var(--cf-text-muted)]">Phone:</span> {application.client.phone}</span>
                      <ContactChannelIcons
                        clientId={application.clientId}
                        clientName={fullName}
                        cannedReplies={cannedRepliesSafe}
                        hasEmail={!!application.client.email}
                        hasPhone={!!application.client.phone}
                      />
                    </p>
                    <p><span className="text-[var(--cf-text-muted)]">Employment:</span> {application.client.employmentStatus || "N/A"}</p>
                  </div>
                </div>
              </DataPanel>

              <DataPanel title="Review path" description={currentStage.label} density="compact">
                <StageList
                  status={application.status}
                  kycVerified={application.client.kycStatus === "VERIFIED"}
                  affordabilityDone={!!application.affordabilityNDI}
                  recklessnessDone={application.recklessLendingAssessed}
                  agreementSigned={agreementReady}
                />
              </DataPanel>
            </div>
          }
          workspace={
            <>
              <DataPanel variant="accent" density="loose">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Current stage</p>
                    <h2 className="mt-2 text-3xl font-semibold leading-tight text-[var(--cf-text)]">{currentStage.label}</h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--cf-text-secondary)]">{currentStage.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {blockers.length > 0 ? <StatusPill tone="warning">{blockers.length} blocker{blockers.length === 1 ? "" : "s"}</StatusPill> : <StatusPill tone="success">No blockers</StatusPill>}
                    {application.status === "APPROVED" && <StatusPill tone="success"><CheckCircle className="h-3.5 w-3.5" />Approved</StatusPill>}
                    {application.status === "DECLINED" && <StatusPill tone="danger"><XCircle className="h-3.5 w-3.5" />Declined</StatusPill>}
                    {application.status === "DISBURSED" && <StatusPill tone="success"><CheckCircle className="h-3.5 w-3.5" />Disbursed</StatusPill>}
                  </div>
                </div>
                {application.decisionReason && <p className="mt-4 text-sm text-[var(--cf-text-muted)]"><span className="font-medium text-[var(--cf-text-secondary)]">Decision Note:</span> {application.decisionReason}</p>}
              </DataPanel>

        {/* Pipeline Stepper */}
        <PipelineStepper
          status={application.status as "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "DISBURSED" | "DECLINED" | "CANCELLED"}
          kycVerified={application.client.kycStatus === "VERIFIED"}
          affordabilityDone={!!application.affordabilityNDI}
          recklessnessDone={application.recklessLendingAssessed}
          agreementSigned={agreementReady}
        />

        {/* Status Banner */}
        <DataPanel>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={getStatusTone(application.status)} className="px-3 py-1.5 text-sm">{application.status.replace("_", " ")}</Badge>
              {application.agreementType && <Badge variant="info">{application.agreementType} Agreement</Badge>}
              {application.status === "APPROVED" && <span className="text-sm flex items-center gap-1 text-[var(--cf-success)]"><CheckCircle className="h-4 w-4" />Approved {formatDate(application.approvedAt!)}</span>}
              {application.status === "DECLINED" && <span className="text-sm flex items-center gap-1 text-[var(--cf-danger)]"><XCircle className="h-4 w-4" />Declined</span>}
              {application.status === "DISBURSED" && application.loan && (
                <Link href={`/loans/${application.loan.id}`} className="text-sm font-medium hover:underline flex items-center gap-1 text-[var(--cf-success)]">
                  <CheckCircle className="h-4 w-4" />Loan {application.loan.reference} →
                </Link>
              )}
            </div>
          </div>
          {application.decisionReason && <p className="mt-3 text-sm text-[var(--cf-text-muted)]"><span className="font-medium text-[var(--cf-text-secondary)]">Decision Note:</span> {application.decisionReason}</p>}
        </DataPanel>

        {/* Document mismatch warning */}
        {docMismatches.length > 0 && (
          <div className="rounded-lg border border-[rgba(217,154,58,0.28)] bg-[rgba(217,154,58,0.08)] p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-[var(--cf-warning)] mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-[var(--cf-warning)]">
                  {docMismatches.length} document(s) have data mismatches
                </p>
                <p className="text-sm text-[var(--cf-text-secondary)] mt-1">
                  Review documents before submitting for credit assessment. Unresolved mismatches will block the review process.
                </p>
                <ul className="mt-2 space-y-1">
                  {docMismatches.map((d) => (
                    <li key={d.id} className="text-sm text-[var(--cf-text-secondary)]">
                      &bull; {d.docType.replace(/_/g, " ")} — {d.fileName}
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/clients/${application.clientId}?tab=documents`}
                  className="inline-block mt-2 text-sm text-[var(--cf-brand-soft)] font-medium underline"
                >
                  Review client documents
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* KYC incomplete warning */}
        {kycMissingDocs && kycMissingDocs.length > 0 && (
          <div className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-[var(--cf-danger)] mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-red-800">
                  KYC verification incomplete — {kycStage} blocked
                </p>
                <p className="text-sm text-[var(--cf-text-secondary)] mt-1">
                  KYC must be completed and verified before this application can continue.
                  Each document below needs a different action:
                </p>
                <ul className="mt-2 space-y-1">
                  {kycDocumentGaps.map((gap) => (
                    <li key={gap.docType} className="text-sm text-[var(--cf-text-secondary)]">
                      &bull; {DOC_TYPE_LABELS[gap.docType]}
                      {" — "}
                      <span className="text-[var(--cf-warning)]">{KYC_GAP_LABELS[gap.state]}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/clients/${application.clientId}?tab=documents`}
                  className="inline-block mt-2 text-sm text-[var(--cf-brand-soft)] font-medium underline"
                >
                  Complete KYC
                </Link>
              </div>
            </div>
          </div>
        )}

        {/* Selfie capture link — lets a consultant working the deal over
            WhatsApp/SMS send the consumer a one-time link instead of requiring
            them to come in or register on the portal. Shown for the same
            statuses the token resolver treats as capturable, so the panel never
            offers a link the consumer's click would be refused. */}
        {(application.status === "SUBMITTED"
          || application.status === "UNDER_REVIEW"
          || application.status === "APPROVED") && (
          <SelfieLinkSection
            applicationId={application.id}
            latestToken={latestSelfieTokenView}
            smsEnabled={isSmsChannelEnabled()}
          />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Client Info */}
          <DataPanel title="Client Information">
            <div className="space-y-2 text-sm text-[var(--cf-text-secondary)]">
              <p><span className="text-[var(--cf-text-muted)]">Name:</span> <Link href={`/clients/${application.client.id}`} className="text-[var(--cf-brand-soft)] hover:underline">{application.client.firstName} {application.client.lastName}</Link></p>
              <p><span className="text-[var(--cf-text-muted)]">ID Number:</span> {application.client.idNumber}</p>
              <p><span className="text-[var(--cf-text-muted)]">Email:</span> {application.client.email}</p>
              <p><span className="text-[var(--cf-text-muted)]">Phone:</span> {application.client.phone}</p>
              <p><span className="text-[var(--cf-text-muted)]">Employment:</span> {application.client.employmentStatus || "N/A"}</p>
              {application.loanPurposeCategory && <p><span className="text-[var(--cf-text-muted)]">Loan Purpose:</span> {application.loanPurposeCategory.replace(/_/g, " ")}</p>}
            </div>
          </DataPanel>

        </div>

        {/* Affordability Capture */}
        <AffordabilityCapture
          applicationId={application.id}
          monthlyIncome={displayedMonthlyIncome}
          monthlyExpenses={displayedMonthlyExpenses}
          existingDebts={displayedDebtRows}
          clientDebtTotal={clientDebtTotal}
          proposedInstalment={displayedProposedInstalment}
          affordabilityNDI={application.affordabilityNDI}
          done={!!application.affordabilityNDI}
          readOnly={affordabilityLocked}
          snapshotUnavailable={affordabilityLocked && !affordabilitySnapshot}
          debtEvidenceInvalid={applicationDebtEvidenceInvalid}
          clientDebtEvidenceInvalid={clientDebtEvidenceInvalid}
          lockedAssessment={affordabilityLocked && affordabilitySnapshot
            ? {
                totalExistingDebt: Math.max(
                  affordabilitySnapshot.inputs.declaredDebtCents,
                  affordabilitySnapshot.inputs.bureauObligationsCents,
                ),
                netDisposableIncome: affordabilitySnapshot.outcome.netDisposableIncomeCents,
                ndiAfterLoan: affordabilitySnapshot.outcome.ndiAfterLoanCents,
                isAffordable: affordabilitySnapshot.outcome.isAffordable,
              }
            : undefined}
        />

        {/* Loan Details */}
        {decisionPricingUnavailable ? (
          <DataPanel title="Loan Details">
            <p className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4 text-sm text-[var(--cf-danger)]">
              Immutable approval pricing evidence is missing. Live product pricing is not substituted. Return this application to review and approve it again.
            </p>
          </DataPanel>
        ) : (
          <DataPanel title="Loan Details">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <DetailMetric label="Product" value={application.product.name} />
            <DetailMetric label="Principal" value={<span className="whitespace-nowrap">{formatZAR(displayedPrincipal)}</span>} />
            <DetailMetric label="Term" value={formatTermDays(displayedTermDays)} />
            <DetailMetric label="Total Repayable" value={<span className="whitespace-nowrap">{formatZAR(loanCalc.totalRepayable)}</span>} highlight />
          </div>
          {/* Six tiles: 2 / 3 / 6 all divide exactly, so no stranded cell. */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <DetailMini label="Interest Rate" value={`${(displayedInterestRatePm * 100).toFixed(1)}% p.m.`} />
            {/* What the consumer actually pays over this term, beside the
                annualised comparison figure. On a 30-day loan at 5% p.m. the
                cost is 5% — the annual rate is a comparison metric, not a
                charge, so the two must not be confused. */}
            <DetailMini label="Interest this term" value={`${termInterestPct.toFixed(1)}% over ${application.appliedTermDays}d`} />
            <DetailMini label="Annual rate (nominal)" value={`${annualRate.percent.toFixed(1)}% p.a.`} />
            <DetailMini label="Total Interest" value={formatZAR(loanCalc.totalInterest)} />
            <DetailMini label="Initiation Fee" value={formatZAR(loanCalc.initiationFee)} />
            <DetailMini label="Service Fees" value={formatZAR(loanCalc.serviceFees)} />
          </div>
          {application.purpose && <div className="mt-4"><p className="text-sm text-[var(--cf-text-muted)]">Purpose</p><p className="mt-1 text-[var(--cf-text-secondary)]">{application.purpose}</p></div>}
          </DataPanel>
        )}

        {/* Compliance Capture */}
        <ComplianceCapture
          applicationId={application.id}
          recklessDone={application.recklessLendingAssessed}
          recklessNote={application.recklessLendingNote}
          affordabilityDeclared={!!application.clientAffordabilityDeclaredAt}
        />

        {canReadChecks && (
          <CreditChecksPanel
            applicationId={application.id}
            canClear={canApprove && (session?.user?.totpVerified === true || demoStaffWithoutTotp()) && checksUndecided}
            needsTotp={canApprove && session?.user?.totpVerified !== true && !demoStaffWithoutTotp() && checksUndecided}
            initialOpenCount={openChecks}
          />
        )}

        {canReadChecks && <StatementInsightsPanel applicationId={application.id} />}

        {/* Credit Bureau Check */}
        {(application.status === "UNDER_REVIEW" || application.status === "APPROVED" || application.status === "DECLINED" || application.status === "DISBURSED") && (
          <DataPanel title="Credit Bureau Check">
            <CreditBureauCheckPanel
              display={bureauDisplay}
              bureauDebt={bureauDebt}
              selfDeclaredDebt={selfDeclaredDebt}
            />
          </DataPanel>
        )}

        {/* AVS bank-account verification — sits next to bank/financial details, ahead of
            disbursement. Gated behind collectionsEngineEnabled: flag-off must be
            byte-identical to pre-Phase-7 behavior (no card, no query). */}
        {collectionsEngineEnabled && (
          <AvsStatusCard
            applicationId={application.id}
            latest={latestAvsCheck ? {
              passed: latestAvsCheck.passed,
              accountNumber: latestAvsCheck.accountNumber,
              createdAt: latestAvsCheck.createdAt.toISOString(),
              subjectMatches: avsCheckMatchesSubject(latestAvsCheck, application.client),
            } : null}
            currentAccountNumber={application.client.bankAccountNumber}
          />
        )}

        {/* EFT needs verified payout banking; debit order additionally needs the customer's exact mandate. */}
        {application.status === "APPROVED" && !application.loan && application.agreementSignedAt && application.agreementCountersignedAt && repaymentSetupReady && canDisburse && !decisionPricingUnavailable && (
          <DisburseForm
            applicationId={application.id}
            repaymentMethod={application.repaymentMethod}
            principalCents={displayedPrincipal}
            disbursementCents={loanCalc.disbursementAmount}
            clientName={`${application.client.firstName} ${application.client.lastName}`}
            clientBankDetails={{
              bankName: application.client.bankName,
              bankAccountNumber: application.client.bankAccountNumber,
              bankBranchCode: application.client.bankBranchCode,
              accountType: application.client.accountType,
            }}
          />
        )}

        {/* Credit Agreement */}
        {/* Anchored: the document upload dialog links here when staff pick
            "Other" while this application still awaits its signed agreement.
            Filing the returned packet as a loose client document records
            nothing — this panel is the only path that binds it. */}
        <div id="credit-agreement" className="scroll-mt-24">
        {!decisionPricingUnavailable && (
          /* Both figures below MUST come from the SAME calculation.
             FeeElection subtracts one from the other to state, in rands, what
             actually reaches the consumer's account. loanCalc.initiationFee is
             the FROZEN snapshot figure once affordability locks, so pairing it
             with the LIVE application.appliedAmount was two sources for one
             sum — the duplicate-computation class that has already put two
             different numbers on two consumer documents in this repo. */
          <AgreementSection
            applicationId={application.id}
            status={application.status}
            agreementGeneratedAt={application.agreementGeneratedAt?.toISOString() ?? null}
            agreementSignedAt={application.agreementSignedAt?.toISOString() ?? null}
            agreementSignedMethod={agreementSignedDisplayMethod ?? null}
            agreementCountersignedAt={application.agreementCountersignedAt?.toISOString() ?? null}
            agreementDocumentSha256={application.agreementDocumentSha256 ?? null}
            agreementExecutedDocumentId={application.agreementExecutedDocumentId ?? null}
            agreementCountersignedByName={application.agreementCountersignedByName ?? null}
            canCountersign={canApprove}
            providerSignerName={session?.user?.name?.trim() || session?.user?.email || ""}
            initiationFeePayment={application.initiationFeePayment}
            initiationFee={loanCalc.initiationFee}
            principal={loanCalc.principal}
            pasqDocumentSha256={application.pasqDocumentSha256}
            pasqAcknowledged={
              application.pasqAcknowledgedAt !== null
              && application.pasqAcknowledgedSha256 === application.pasqDocumentSha256
            }
            signingKycBlockers={signingKycBlockers.map((b) => ({
              label: b.label,
              detail: b.detail,
            }))}
            clientEmail={application.client.email}
            reference={application.reference}
          />
        )}
        {/* The upload dialog links staff HERE to record a returned signed
            packet, and that link must never land on nothing. Approval pricing
            can be missing on an APPROVED application (the same fail-closed
            path Loan Details above renders for), which is exactly the state
            the link is sent from — so say what to do instead of showing an
            empty anchor. */}
        {decisionPricingUnavailable && (
          <DataPanel title="Credit Agreement">
            <p className="rounded-lg border border-[rgba(208,92,75,0.28)] bg-[rgba(208,92,75,0.08)] p-4 text-sm text-[var(--cf-danger)]">
              Immutable approval pricing evidence is missing, so the credit
              agreement cannot be prepared or a returned signed packet recorded
              against it. Return this application to review and approve it again
              first. Do not file the signed packet as a client document — it
              would bind to nothing.
            </p>
          </DataPanel>
        )}
        </div>

        {/* Repayment Schedule */}
        {!decisionPricingUnavailable && (
          <DataPanel title="Projected Repayment Schedule">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead><TableHead>Due Date</TableHead><TableHead>Principal</TableHead>
                <TableHead>Interest</TableHead><TableHead>Fees</TableHead><TableHead>Total</TableHead><TableHead>Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loanCalc.schedule.map((item) => (
                <TableRow key={item.installmentNo}>
                  <TableCell>{item.installmentNo}</TableCell>
                  <TableCell>{formatDate(item.dueDate)}</TableCell>
                  <TableCell>{formatZAR(item.principalDue)}</TableCell>
                  <TableCell>{formatZAR(item.interestDue)}</TableCell>
                  <TableCell>{formatZAR(item.feesDue)}</TableCell>
                  <TableCell className="font-medium">{formatZAR(item.totalDue)}</TableCell>
                  <TableCell>{formatZAR(item.closingBalance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </DataPanel>
        )}
            </>
          }
          actions={
            <ActionRail
              title="Decision rail"
              description="Primary controls, blockers, and audit history."
              primary={primaryActions}
              secondary={secondaryActions}
              blockers={blockers}
              audit={auditItems}
            />
          }
        />
      </div>
    </>
  )
}

function DetailMetric({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.1)]" : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)]"}`}>
      <p className={`text-sm ${highlight ? "text-[var(--cf-brand-soft)]" : "text-[var(--cf-text-muted)]"}`}>{label}</p>
      <p className="text-lg font-bold text-[var(--cf-text)]">{value}</p>
    </div>
  )
}

function DetailMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm text-[var(--cf-text-muted)]">{label}</p>
      <p className="whitespace-nowrap font-medium text-[var(--cf-text-secondary)]">{value}</p>
    </div>
  )
}

function getApplicationStage(
  status: string,
  flags: { kycVerified: boolean; affordabilityDone: boolean; agreementSigned: boolean }
) {
  if (status === "DRAFT" || status === "SUBMITTED") {
    return {
      label: "Intake and identity",
      description: flags.kycVerified
        ? "The case is ready to move into affordability and credit review."
        : "Confirm client identity and core KYC before underwriting starts.",
    }
  }
  if (status === "UNDER_REVIEW") {
    return {
      label: flags.affordabilityDone ? "Review and decision" : "Affordability review",
      description: flags.affordabilityDone
        ? "Evaluate the completed evidence stack and record an approval, decline, or exception decision."
        : "Verify income, obligations, policy compliance, and repayment suitability before decisioning.",
    }
  }
  if (status === "APPROVED") {
    return {
      label: flags.agreementSigned ? "Disbursement readiness" : "Agreement and signature",
      description: flags.agreementSigned
        ? "The consumer signature and provider countersignature are complete. Confirm disbursement controls and create the active loan."
        : "Generate the agreement, obtain the consumer signature, and record the provider countersignature before any funds are released.",
    }
  }
  if (status === "DISBURSED") {
    return {
      label: "Active loan created",
      description: "The case has converted into an active loan and can be managed from the loan record.",
    }
  }
  if (status === "DECLINED") {
    return {
      label: "Decision recorded",
      description: "The application was declined. Keep the audit trail and client record available for review.",
    }
  }
  return {
    label: "Closed case",
    description: "This case is no longer active, but the evidence and decision history remain available.",
  }
}

function StageList({
  status,
  kycVerified,
  affordabilityDone,
  recklessnessDone,
  agreementSigned,
}: {
  status: string
  kycVerified: boolean
  affordabilityDone: boolean
  recklessnessDone: boolean
  agreementSigned: boolean
}) {
  const items = [
    { label: "Intake and identity", done: kycVerified || !["DRAFT", "SUBMITTED"].includes(status), active: ["DRAFT", "SUBMITTED"].includes(status) },
    { label: "Affordability", done: affordabilityDone, active: status === "UNDER_REVIEW" && !affordabilityDone },
    { label: "Compliance", done: recklessnessDone, active: status === "UNDER_REVIEW" && affordabilityDone },
    { label: "Agreement", done: agreementSigned, active: status === "APPROVED" && !agreementSigned },
    { label: "Disbursement", done: status === "DISBURSED", active: status === "APPROVED" && agreementSigned },
  ]

  return (
    <ol className="space-y-2">
      {items.map((item, index) => (
        <li
          key={item.label}
          className={`flex items-center gap-3 rounded-md border px-3 py-2 text-sm ${
            item.active
              ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.12)] text-[var(--cf-text)]"
              : item.done
                ? "border-[rgba(63,191,127,0.24)] bg-[rgba(63,191,127,0.08)] text-[var(--cf-text-secondary)]"
                : "border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] text-[var(--cf-text-muted)]"
          }`}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-[var(--cf-surface-hover)] text-[11px] font-bold">
            {item.done ? "✓" : index + 1}
          </span>
          <span className="min-w-0">{item.label}</span>
        </li>
      ))}
    </ol>
  )
}
