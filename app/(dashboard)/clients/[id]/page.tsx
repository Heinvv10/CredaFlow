import { ClientRecordActions } from "@/components/clients/ClientRecordActions"
import { notFound } from "next/navigation"
import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { lacksLoanBook } from "@/lib/security/loan-book-scope"
import { clientRelationsWithoutLoanBook } from "@/lib/security/client-redaction"
import { formatZAR, formatDate, formatDateTime } from "@/lib/utils"
import { formatStatusLabel } from "@/lib/status-style"
import { clientStatus, CLIENT_STATUS_BADGE } from "@/lib/clients/status"
import { ClientStatusButton } from "@/components/clients/ClientStatusButton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FileText, Wallet, Shield, FolderOpen, TrendingUp, MessageSquare } from "lucide-react"
import { DocumentsPanel } from "@/components/documents/DocumentsPanel"
import { portalContinueUrl, portalUrlOrNull } from "@/lib/portal-urls"
import { inPersonKycVerificationOffered } from "@/lib/kyc/in-person-verification"
import { SelfieKycTab } from "@/components/clients/SelfieKycTab"
import { KycChecklistTab } from "@/components/clients/KycChecklistTab"
import { FaisDisclosuresSection } from "@/components/clients/FaisDisclosuresSection"
import { ConsentTab } from "@/components/clients/ConsentTab"
import { MessageClientButton } from "@/components/messaging/MessageClientButton"
import { ContactChannelIcons } from "@/components/messaging/ContactChannelIcons"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { getContactComms } from "@/lib/inbox/contact-comms"
import { ClientCommsTab } from "@/components/comms/ClientCommsTab"
import { listGeneratableCustomTemplates } from "@/lib/documents/catalogue"
import { resolveClientTab } from "@/lib/client-tabs"
import { getAuthoritativeStaffSelfie } from "@/lib/kyc/staff-selfie"
import { isManualKycExceptionableAttempt } from "@/lib/kyc/manual-exception-policy"
import { auth } from "@/lib/auth"
import { canDo, hasMinRole } from "@/lib/auth-guards"
import { isDocumentReadOnlyRole } from "@/lib/documents/write-access"
import { ScreeningPanel } from "@/components/clients/ScreeningPanel"
import { RaiseStrButton } from "@/components/clients/RaiseStrButton"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { debtAccountTypeLabel } from "@/lib/credit/debt-account-types"
import { isSimulatedBureauCheck } from "@/lib/decision/bureau-simulated"
import {
  getKycOverridePolicy,
  overrideEligibility,
  readFaceModelSimilarity,
  readFaceVerdict,
} from "@/lib/kyc/override-policy"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { expireAndListPendingKycOverrideRequests } from "@/lib/kyc/override-requests"
import { manualPendingStands } from "@/lib/kyc/manual-pending.server"
import { verificationRestorable } from "@/lib/kyc/verification-restorable"

async function getClient(id: string, tenantId: string) {
  return prisma.client.findUnique({
    where: { id, tenantId },
    include: {
      applications: { orderBy: { createdAt: "desc" }, include: { product: true } },
      loans: { orderBy: { createdAt: "desc" }, include: { product: true } },
      documents: { orderBy: { createdAt: "desc" } },
      expenseBreakdown: true,
      debtObligations: true,
      contact: { select: { id: true } },
    },
  })
}

async function getBureauHistory(clientId: string, tenantId: string) {
  return prisma.creditBureauCheck.findMany({
    where: { tenantId, clientId },
    orderBy: { createdAt: "desc" },
  })
}

interface PageProps { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }

const kycColors: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800", VERIFIED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800", EXPIRED: "bg-gray-100 text-gray-800",
}
const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800", SUBMITTED: "bg-blue-100 text-blue-800",
  UNDER_REVIEW: "bg-amber-100 text-amber-800", APPROVED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800", DISBURSED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-gray-100 text-gray-800", ACTIVE: "bg-green-100 text-green-800",
  COMPLETED: "bg-blue-100 text-blue-800", DEFAULTED: "bg-red-100 text-red-800",
  PENDING_WRITE_OFF: "bg-amber-100 text-amber-800", WRITTEN_OFF: "bg-gray-100 text-gray-500",
}
const amlColors: Record<string, string> = {
  NOT_REQUIRED: "bg-gray-100 text-gray-800", PENDING: "bg-amber-100 text-amber-800",
  CLEARED: "bg-green-100 text-green-800", FLAGGED: "bg-red-100 text-red-800",
}

export default async function ClientDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const { tab } = await searchParams
  const defaultTab = resolveClientTab(tab)
  const tenantId = await getStaffTenantId()
  const [loadedClient, selfieDoc, loadedBureauHistory, cannedReplies, generatableTemplates] = await Promise.all([
    getClient(id, tenantId), getAuthoritativeStaffSelfie(id, tenantId), getBureauHistory(id, tenantId), listCannedReplies(tenantId), listGeneratableCustomTemplates(tenantId, { client: true }),
  ])
  if (!loadedClient) notFound()
  const session = await auth()
  const staffRole = session?.user?.role && session.user.role !== "CLIENT" ? session.user.role : null
  // A role without the loan book (INSURANCE_OFFICER) sees the client, not its
  // applications, loans, affordability evidence, lending figures or bureau
  // history (lib/security/client-redaction.ts).
  const showLoanBook = !lacksLoanBook(staffRole)
  const client = showLoanBook ? loadedClient : clientRelationsWithoutLoanBook(loadedClient)
  const bureauHistory = showLoanBook ? loadedBureauHistory : []
  // The session role is revalidated against the User row on every request
  // (lib/auth.ts), so this hides exactly the controls the document routes refuse.
  const documentsReadOnly = isDocumentReadOnlyRole(staffRole)
  const [compositeKyc, overridePolicyBase, requireStaffTotp, pendingOverrideRequests, kycManualPendingStands] = await Promise.all([
    readCompositeKycState(
      prisma as unknown as CompositeKycReader,
      {
        tenantId,
        clientId: client.id,
        subject: client,
        existing: client,
        preserveVerifiedProvenance: true,
      },
    ),
    getKycOverridePolicy(tenantId),
    isStaffTotpRequired(tenantId),
    session?.user?.id && session.user.email
      ? expireAndListPendingKycOverrideRequests({
          tenantId,
          clientId: id,
          actor: { id: session.user.id, email: session.user.email },
        })
      : Promise.resolve([]),
    manualPendingStands(prisma, { tenantId, clientId: client.id }),
  ])
  const manualException = compositeKyc.manualException
    ? {
        reason: compositeKyc.manualException.reason,
        supportingEvidence: compositeKyc.manualException.supportingEvidence,
        biometricFailureReason:
          compositeKyc.manualException.biometricFailureReason,
        approvedAt: compositeKyc.manualException.approvedAt,
        approvedByEmail: compositeKyc.manualException.approvedByEmail,
      }
    : null
  const inPersonVerification = compositeKyc.inPersonVerification
    ? {
        method: compositeKyc.inPersonVerification.method,
        note: compositeKyc.inPersonVerification.note,
        approvedAt: compositeKyc.inPersonVerification.approvedAt,
        approvedByEmail: compositeKyc.inPersonVerification.approvedByEmail,
      }
    : null
  const overridePolicy = { ...overridePolicyBase, requireStaffTotp }
  // Both ways past a selfie the client cannot take on this device. Built here
  // because the portal link needs the client's email AND reference —
  // /portal/continue falls through to the register form without both, which
  // would send a registered client somewhere they cannot use.
  const selfieAlternatives = {
    portalUrl: portalUrlOrNull(() => portalContinueUrl(client.email, client.reference, "/portal/documents")),
    kycHref: `/clients/${client.id}?tab=kyc#kyc-identity-verification`,
    // Same predicate SelfieKycTab gates the form on, evaluated once here, so
    // the pointer never names a control that tab is not rendering.
    inPersonOffered: inPersonKycVerificationOffered({
      manualExceptionActive: Boolean(manualException),
      inPersonVerificationRecorded: Boolean(inPersonVerification),
      coreDocumentsComplete: compositeKyc.missingCoreDocuments.length === 0,
      manualRejectionActive: client.kycManualRejectionActive,
      ...compositeKyc.inPersonRoute,
    }),
  }
  // The application a returned signed packet would belong to. Twin of the
  // where clause the upload route warns on after the fact
  // (app/api/documents/route.ts: status APPROVED, agreementSignedAt null,
  // newest first) — said here BEFORE the upload instead, while the choice is
  // still the staff member's. Derived from the applications already loaded, so
  // it costs no query and cannot disagree with what the page renders.
  const awaitingSignedAgreement = client.applications.find(
    (application) =>
      application.status === "APPROVED" && application.agreementSignedAt === null,
  )
  const signedAgreementReturn = awaitingSignedAgreement
    ? {
        reference: awaitingSignedAgreement.reference,
        href: `/applications/${awaitingSignedAgreement.id}#credit-agreement`,
      }
    : undefined

  // Derived, not stored: the loans are already loaded above, so this costs no
  // extra query and cannot fall out of step with them.
  const status = clientStatus(client)
  // The STORED status; the derived exception only names a stored VERIFIED.
  const kycBadge = compositeKyc.manualExceptionActive && client.kycStatus === "VERIFIED"
    ? {
        label: "MANUAL EXCEPTION",
        className: "bg-amber-100 text-amber-900",
      }
    : {
        label: client.kycStatus,
        className: kycColors[client.kycStatus],
      }

  const cannedRepliesSafe = cannedReplies.map((c) => ({ id: c.id, title: c.title, body: c.body }))

  // These are already CUSTOM, published, and satisfiable with client-only
  // context; SYSTEM documents remain on their dedicated statutory routes.
  const customTemplates = generatableTemplates
    .map((t) => ({ key: t.key, name: t.name, category: t.category, signingMethod: t.signingMethod }))

  const comms = client.contact
    ? await getContactComms({ tenantId, contactId: client.contact.id })
    : null

  const consent = await prisma.clientConsent.findUnique({
    where: { clientId: client.id },
  })

  const consentAudit = consent
    ? (await prisma.auditLog.findMany({
        where: {
          entity: "ClientConsent",
          entityId: consent.id,
          action: { in: ["CONSENT_GRANTED", "CONSENT_WITHDRAWN", "CONSENT_PURPOSE_CHANGED"] },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          action: true,
          createdAt: true,
          userEmail: true,
          newValue: true,
        },
      })).map((r) => ({
        id: r.id,
        action: r.action as "CONSENT_GRANTED" | "CONSENT_WITHDRAWN" | "CONSENT_PURPOSE_CHANGED",
        createdAt: r.createdAt,
        actorName: r.userEmail,
        newValue: r.newValue as Record<string, unknown> | null,
      }))
    : []

  // Exactly the predicate POST /api/clients/[id]/kyc-exception enforces, so the
  // tab can never offer a senior exception the route would refuse. For a failed
  // or skipped attempt `biometricEvidence` IS the persisted failure reason
  // (assessBiometricEvidence returns it verbatim), which is the same value the
  // route reads off the document.
  const seniorExceptionAvailable =
    compositeKyc.biometricAttemptFailed &&
    selfieDoc !== null &&
    isManualKycExceptionableAttempt({
      extractionStatus: selfieDoc.extractionStatus,
      biometricFailureReason: compositeKyc.biometricEvidence,
    })

  const exceptionEligibility = session?.user?.role && session.user.role !== "CLIENT" ? overrideEligibility({
    kind: "EXCEPTION",
    mode: overridePolicy.secondApprover ? "request" : "direct",
    attempt: selfieDoc ? {
      extractionStatus: selfieDoc.extractionStatus,
      biometricFailureReason: compositeKyc.biometricEvidence,
      similarity: readFaceModelSimilarity(selfieDoc.biometricResult),
      faceVerdict: readFaceVerdict(selfieDoc.biometricResult),
    } : null,
    policy: overridePolicy,
    caller: { role: session.user.role, totpVerified: session.user.totpVerified === true },
  }) : { allowed: false as const, code: "role_below_policy" as const }
  const inPersonEligibility = session?.user?.role && session.user.role !== "CLIENT" ? overrideEligibility({
    kind: "IN_PERSON",
    mode: overridePolicy.secondApprover ? "request" : "direct",
    attempt: null,
    policy: overridePolicy,
    caller: { role: session.user.role, totpVerified: session.user.totpVerified === true },
  }) : { allowed: false as const, code: "role_below_policy" as const }
  const reviewerEligibility = session?.user?.role && session.user.role !== "CLIENT" ? overrideEligibility({
    kind: "IN_PERSON",
    mode: "approve",
    attempt: null,
    policy: { ...overridePolicy, enabled: true },
    caller: { role: session.user.role, totpVerified: session.user.totpVerified === true },
  }) : { allowed: false as const, code: "role_below_policy" as const }

  const selfieImageUrl = selfieDoc?.deletedAt === null && selfieDoc.storagePath
    ? `/api/documents/${selfieDoc.id}/view`
    : null

  const selfieDocSafe = selfieDoc ? {
    id: selfieDoc.id,
    fileName: selfieDoc.fileName,
    mimeType: selfieDoc.mimeType,
    deletedAt: selfieDoc.deletedAt?.toISOString() ?? null,
    biometricMatchScore: selfieDoc.biometricMatchScore,
    biometricLiveness: selfieDoc.biometricLiveness,
    biometricVerifiedAt: selfieDoc.biometricVerifiedAt?.toISOString() ?? null,
    extractionStatus: selfieDoc.extractionStatus,
    verifiedAt: selfieDoc.verifiedAt?.toISOString() ?? null,
    verificationNote: selfieDoc.verificationNote,
    createdAt: selfieDoc.createdAt.toISOString(),
  } : null

  const disposableIncome = client.monthlyIncome - client.monthlyExpenses
  const totalDebtRepayments = client.debtObligations.reduce((s, d) => s + d.monthlyInstalment, 0)
  const eb = client.expenseBreakdown

  return (
    <>
      <Header
        title={`${client.firstName} ${client.lastName}`}
        subtitle={`Client ID: ${client.reference}`}
        breadcrumbs={[
          { label: "Clients", href: "/clients" },
          { label: `${client.firstName} ${client.lastName}` },
        ]}
      />
      <div className="p-4 lg:p-8 space-y-6">
        {/* Client Overview */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <Badge className={kycBadge.className}>{kycBadge.label}</Badge>
              <Badge className={`ml-2 ${CLIENT_STATUS_BADGE[status].className}`}>
                {CLIENT_STATUS_BADGE[status].label}
              </Badge>
              {client.popiaConsentGiven && <Badge className="ml-2 bg-green-100 text-green-800">POPIA</Badge>}
            </div>
            <div className="flex gap-2">
              <MessageClientButton
                clientId={client.id}
                clientName={`${client.firstName} ${client.lastName}`}
                cannedReplies={cannedRepliesSafe}
              />
              {showLoanBook && <ClientRecordActions role={staffRole} clientId={client.id} />}
            </div>
          </div>
          {/* Gated to match the API guard on PATCH /api/clients/[id]/status.
              The API is the real gate; this only avoids offering an action
              that would 403. */}
          {session?.user?.role && hasMinRole(session.user.role, "LOAN_ADMIN") && (
            <div className="mb-6 flex justify-end">
              <ClientStatusButton
                clientId={client.id}
                blacklisted={client.blacklisted}
                deceased={client.deceasedAt !== null}
              />
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Personal Details</h4>
              <p className="text-sm"><span className="text-gray-500">ID:</span> {client.idNumber}</p>
              <p className="text-sm"><span className="text-gray-500">DOB:</span> {client.dateOfBirth ? formatDate(client.dateOfBirth) : "N/A"}</p>
              <p className="text-sm"><span className="text-gray-500">Gender:</span> {client.gender || "N/A"}</p>
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2 flex items-center gap-2">
                Contact
                <ContactChannelIcons
                  clientId={client.id}
                  clientName={`${client.firstName} ${client.lastName}`}
                  cannedReplies={cannedRepliesSafe}
                  hasEmail={!!client.email}
                  hasPhone={!!client.phone}
                />
              </h4>
              <p className="text-sm">{client.email}</p>
              <p className="text-sm">{client.phone}</p>
              {client.whatsapp && <p className="text-sm">WA: {client.whatsapp}</p>}
            </div>
            <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Employment</h4>
              <p className="text-sm">{client.employmentStatus?.replace("_", " ") || "N/A"}</p>
              <p className="text-sm">{client.employerName || "N/A"}</p>
              {showLoanBook && client.incomeSourceType && <p className="text-sm">{client.incomeSourceType.replace(/_/g, " ")}</p>}
            </div>
            {showLoanBook && <div>
              <h4 className="text-sm font-medium text-gray-500 mb-2">Financial</h4>
              {client.grossMonthlyIncome && <p className="text-sm"><span className="text-gray-500">Gross:</span> {formatZAR(client.grossMonthlyIncome)}</p>}
              <p className="text-sm"><span className="text-gray-500">Net Income:</span> {formatZAR(client.monthlyIncome)}</p>
              <p className="text-sm"><span className="text-gray-500">Expenses:</span> {formatZAR(client.monthlyExpenses)}</p>
              {totalDebtRepayments > 0 && <p className="text-sm"><span className="text-gray-500">Debt:</span> {formatZAR(totalDebtRepayments)}</p>}
              <p className="text-sm font-semibold">
                <span className="text-gray-500">Disposable:</span>{" "}
                <span className={disposableIncome > 0 ? "text-green-600" : "text-red-600"}>{formatZAR(disposableIncome)}</span>
              </p>
            </div>}
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue={showLoanBook || !["applications", "loans", "bureau"].includes(defaultTab) ? defaultTab : "documents"} className="space-y-4">
          <TabsList>
            {showLoanBook && <TabsTrigger value="applications" className="flex items-center gap-2"><FileText className="h-4 w-4" />Applications ({client.applications.length})</TabsTrigger>}
            {showLoanBook && <TabsTrigger value="loans" className="flex items-center gap-2"><Wallet className="h-4 w-4" />Loans ({client.loans.length})</TabsTrigger>}
            <TabsTrigger value="documents" className="flex items-center gap-2"><FolderOpen className="h-4 w-4" />Documents ({client.documents.length})</TabsTrigger>
            <TabsTrigger value="kyc" className="flex items-center gap-2"><Shield className="h-4 w-4" />KYC</TabsTrigger>
            <TabsTrigger value="compliance" className="flex items-center gap-2"><Shield className="h-4 w-4" />Compliance</TabsTrigger>
            <TabsTrigger value="consent" className="flex items-center gap-2"><Shield className="h-4 w-4" />Consent</TabsTrigger>
            <TabsTrigger value="comms" className="flex items-center gap-2"><MessageSquare className="h-4 w-4" />Comms{comms ? ` (${comms.messages.length})` : ""}</TabsTrigger>
            {showLoanBook && <TabsTrigger value="bureau" className="flex items-center gap-2"><TrendingUp className="h-4 w-4" />Bureau ({bureauHistory.length})</TabsTrigger>}
          </TabsList>

          <TabsContent value="applications">
            <div className="bg-white rounded-lg shadow-sm">
              {client.applications.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No applications yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Product</TableHead><TableHead>Amount</TableHead><TableHead>Term</TableHead><TableHead>Status</TableHead><TableHead>Date</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {client.applications.map((app) => (
                      <TableRow key={app.id}>
                        <TableCell><Link href={`/applications/${app.id}`} className="text-blue-600 hover:underline">{app.reference}</Link></TableCell>
                        <TableCell>{app.product.name}</TableCell>
                        <TableCell>{formatZAR(app.appliedAmount)}</TableCell>
                        <TableCell>{app.appliedTermDays} days</TableCell>
                        <TableCell><Badge className={statusColors[app.status]}>{formatStatusLabel(app.status)}</Badge></TableCell>
                        <TableCell>{formatDate(app.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="loans">
            <div className="bg-white rounded-lg shadow-sm">
              {client.loans.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No loans yet</div>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Product</TableHead><TableHead>Principal</TableHead><TableHead>Outstanding</TableHead><TableHead>Status</TableHead><TableHead>Start Date</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {client.loans.map((loan) => (
                      <TableRow key={loan.id}>
                        <TableCell><Link href={`/loans/${loan.id}`} className="text-blue-600 hover:underline">{loan.reference}</Link></TableCell>
                        <TableCell>{loan.product.name}</TableCell>
                        <TableCell>{formatZAR(loan.principal)}</TableCell>
                        <TableCell>{formatZAR(loan.outstandingPrincipal)}</TableCell>
                        <TableCell><Badge className={statusColors[loan.status]}>{formatStatusLabel(loan.status)}</Badge></TableCell>
                        <TableCell>{formatDate(loan.startDate)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="documents">
            <DocumentsPanel
              clientId={client.id}
              popiaConsentGiven={client.popiaConsentGiven}
              customTemplates={customTemplates}
              selfieAlternatives={selfieAlternatives}
              signedAgreementReturn={signedAgreementReturn}
              readOnly={documentsReadOnly}
            />
          </TabsContent>

          <TabsContent value="kyc">
            <div className="space-y-6">
              <KycChecklistTab
                clientId={client.id}
                kycStatus={client.kycStatus}
                manualExceptionActive={compositeKyc.manualExceptionActive}
                substituteKind={compositeKyc.substituteKind}
                verificationRestorable={verificationRestorable(client.kycStatus, compositeKyc, {
                  manualPendingStands: kycManualPendingStands,
                })}
                selfieAlternatives={selfieAlternatives}
                signedAgreementReturn={signedAgreementReturn}
                readOnly={documentsReadOnly}
              />
              <SelfieKycTab
                clientId={client.id}
                currentKycStatus={client.kycStatus}
                currentManualRejectionActive={client.kycManualRejectionActive}
                currentManualRejectionReason={client.kycManualRejectionReason}
                selfieDoc={selfieDocSafe}
                imageUrl={selfieImageUrl}
                currentManualException={manualException}
                canGrantManualException={exceptionEligibility.allowed}
                canRecordInPersonVerification={inPersonEligibility.allowed}
                canDecideOverrideRequest={reviewerEligibility.allowed}
                overrideRefusalCode={exceptionEligibility.allowed ? null : exceptionEligibility.code}
                inPersonOverrideRefusalCode={inPersonEligibility.allowed ? null : inPersonEligibility.code}
                overrideMinRole={overridePolicy.minRole}
                secondApproverRequired={overridePolicy.secondApprover}
                currentUserId={session?.user?.id ?? null}
                readOnly={documentsReadOnly}
                pendingOverrideRequests={pendingOverrideRequests.map((request) => ({
                  ...request,
                  requestedAt: request.requestedAt.toISOString(),
                  expiresAt: request.expiresAt.toISOString(),
                }))}
                currentInPersonVerification={inPersonVerification}
                coreDocumentsComplete={compositeKyc.missingCoreDocuments.length === 0}
                biometricEvidence={compositeKyc.biometricEvidence}
                biometricAttemptFailed={compositeKyc.biometricAttemptFailed}
                biometricAwaitingIdVerification={compositeKyc.biometricAwaitingIdVerification}
                inPersonRoute={compositeKyc.inPersonRoute}
                seniorExceptionAvailable={seniorExceptionAvailable}
              />
            </div>
          </TabsContent>

          <TabsContent value="compliance">
            <div className="space-y-6">
              {/* Expense Breakdown */}
              {eb && (
                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Expense Breakdown</h3>
                  <Table>
                    <TableHeader><TableRow><TableHead>Category</TableHead><TableHead>Amount</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {[
                        { label: "Housing/Rent", value: eb.housing },
                        { label: "Transport", value: eb.transport },
                        { label: "Food & Groceries", value: eb.food },
                        { label: "Education", value: eb.education },
                        { label: "Insurance", value: eb.insurance },
                        { label: "Clothing", value: eb.clothing },
                        { label: "Entertainment", value: eb.entertainment },
                        { label: "Medical", value: eb.medical },
                        { label: "Other", value: eb.other },
                      ].map((row) => (
                        <TableRow key={row.label}><TableCell>{row.label}</TableCell><TableCell>{formatZAR(row.value)}</TableCell></TableRow>
                      ))}
                      <TableRow className="font-semibold">
                        <TableCell>Total</TableCell>
                        <TableCell>{formatZAR(eb.housing + eb.transport + eb.food + eb.education + eb.insurance + eb.clothing + eb.entertainment + eb.medical + eb.other)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Debt Obligations */}
              {client.debtObligations.length > 0 && (
                <div className="bg-white rounded-lg shadow-sm p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Existing Debt Obligations</h3>
                  <Table>
                    <TableHeader><TableRow><TableHead>Provider</TableHead><TableHead>Type</TableHead><TableHead>Balance</TableHead><TableHead>Monthly</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {client.debtObligations.map((d) => (
                        <TableRow key={d.id}><TableCell>{d.creditProvider}</TableCell><TableCell>{debtAccountTypeLabel(d.accountType)}</TableCell><TableCell>{formatZAR(d.outstandingBalance)}</TableCell><TableCell>{formatZAR(d.monthlyInstalment)}</TableCell></TableRow>
                      ))}
                      <TableRow className="font-semibold"><TableCell colSpan={3}>Total Monthly</TableCell><TableCell>{formatZAR(totalDebtRepayments)}</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* FAIS Disclosures */}
              <FaisDisclosuresSection clientId={client.id} />

              {/* Compliance Status */}
              <div className="bg-white rounded-lg shadow-sm p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Compliance Status</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                  <div className="p-3 bg-gray-50 rounded">
                    <p className="text-gray-500">POPIA Consent</p>
                    <p className="font-medium">{client.popiaConsentGiven ? `Granted ${client.popiaConsentAt ? formatDateTime(client.popiaConsentAt) : ""}` : "Not given"}</p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded">
                    <p className="text-gray-500">KYC Verification</p>
                    <p className="font-medium">
                      <Badge className={kycBadge.className}>{kycBadge.label}</Badge>
                      {client.kycVerificationMethod && (
                        <span className="ml-2">
                          {compositeKyc.substituteKind === "in_person"
                            ? "PHYSICAL / VERIFIED IN PERSON"
                            : compositeKyc.substituteKind === "senior_exception"
                              ? "PHYSICAL / SENIOR EXCEPTION"
                              : client.kycVerificationMethod}
                        </span>
                      )}
                      {client.kycVerifiedAt && <span className="ml-2 text-gray-400">{formatDateTime(client.kycVerifiedAt)}</span>}
                    </p>
                  </div>
                  <div className="p-3 bg-gray-50 rounded">
                    <p className="text-gray-500">AML Screening</p>
                    <p className="font-medium">
                      <Badge className={amlColors[client.amlScreeningStatus]}>{client.amlScreeningStatus.replace("_", " ")}</Badge>
                      {client.amlScreeningAt && <span className="ml-2 text-gray-400">{formatDateTime(client.amlScreeningAt)}</span>}
                    </p>
                  </div>
                </div>
                {staffRole && hasMinRole(staffRole, "CREDIT_OFFICER") && <ScreeningPanel endpoint={`/api/clients/${client.id}/screening`} />}
                {staffRole && canDo(staffRole, "raise_suspicious_report") && <RaiseStrButton clientId={client.id} />}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="consent">
            <ConsentTab
              clientId={client.id}
              initial={{
                creditBureauEnquiry: consent?.creditBureauEnquiry ?? false,
                insuranceUnderwriting: consent?.insuranceUnderwriting ?? false,
                smsMarketing: consent?.smsMarketing ?? false,
                emailMarketing: consent?.emailMarketing ?? false,
                thirdPartySharing: consent?.thirdPartySharing ?? false,
                automatedDecisionMaking: consent?.automatedDecisionMaking ?? false,
                capturedAt: consent?.capturedAt ?? null,
                withdrawnAt: consent?.withdrawnAt ?? null,
              }}
              recentAudit={consentAudit}
            />
          </TabsContent>

          <TabsContent value="bureau">
            <div className="bg-white rounded-lg shadow-sm p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Credit Bureau History</h3>
              {bureauHistory.length === 0 ? (
                <p className="text-gray-500 text-sm">No bureau checks on record. A check runs automatically when an application enters review.</p>
              ) : (
                <div className="space-y-4">
                  {bureauHistory.map((check) => {
                    const adverseInfo = (check.adverseInfo ?? []) as string[]
                    const scoreColor = !check.score ? "text-gray-600" : check.score >= 650 ? "text-green-600" : check.score >= 500 ? "text-amber-600" : "text-red-600"
                    return (
                      <div key={check.id} className={`rounded-lg border p-4 ${check.hasAdverse ? "border-red-200 bg-red-50" : "border-gray-200"}`}>
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{check.provider}</span>
                            {isSimulatedBureauCheck(check.obligations) && (
                              <span className="text-xs font-semibold text-amber-700">Simulated result — not a real bureau check</span>
                            )}
                            {check.applicationId && (
                              <a href={`/applications/${check.applicationId}`} className="text-xs text-blue-600 hover:underline">View Application →</a>
                            )}
                          </div>
                          <span className="text-xs text-gray-400">{formatDateTime(check.createdAt)}</span>
                        </div>
                        {!check.ok ? (
                          <p className="text-sm text-red-700">Check failed: {check.errorMessage ?? "Unknown error"}</p>
                        ) : (
                          <div className="grid grid-cols-3 gap-4">
                            <div>
                              <p className="text-xs text-gray-500">Credit Score</p>
                              <p className={`text-2xl font-bold ${scoreColor}`}>{check.score ?? "N/A"}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Risk Grade</p>
                              <p className="text-2xl font-bold text-gray-800">{check.riskGrade ?? "N/A"}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Adverse Records</p>
                              <p className={`text-2xl font-bold ${check.hasAdverse ? "text-red-600" : "text-green-600"}`}>{adverseInfo.length}</p>
                            </div>
                          </div>
                        )}
                        {adverseInfo.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {adverseInfo.map((item, i) => (
                              <li key={i} className="text-sm text-red-700">&bull; {item}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="comms">
            <ClientCommsTab
              key={client.id}
              clientId={client.id}
              hasContact={!!client.contact}
              comms={comms ?? { conversations: [], messages: [], channelAvailability: { EMAIL: { enabled: false }, WHATSAPP: { enabled: false }, SMS: { enabled: false } }, waWindow: { open: false, expiresAt: null }, replyChannels: [] }}
              cannedReplies={cannedRepliesSafe}
              currentUserId={session?.user?.id}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
