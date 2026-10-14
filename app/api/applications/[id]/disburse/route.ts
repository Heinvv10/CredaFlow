import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateReference } from "@/lib/utils"
import { triggerNotification } from "@/lib/notifications"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { auditRefusal, refusalReasonFrom } from "@/lib/audit-refusals"
import { requireApiRole } from "@/lib/auth-guards"
import { DisbursementBankDetailsError, resolveDisbursementBankDetails } from "@/lib/disbursement-bank-details"
import { bureauStalenessCutoff } from "@/lib/compliance/bureau"
import { generateFaisDisclosurePdf } from "@/lib/pdf/faisDisclosure"
import { readFile, saveFile } from "@/lib/storage"
import { getLenderIdentity } from "@/lib/config/identity"
import { recordDisbursementCommission } from "@/lib/referral-agents/commission"
import { evaluateAvsGate } from "@/lib/avs"
import {
  acceptedPasqCalculatorFingerprint,
  affordabilityContractCanBeDisbursed,
  type BureauDecisionCheckInput,
} from "@/lib/affordability/snapshot"
import { sastCalendarDaysBetween } from "@/lib/compliance/sa-business-days"
import {
  verifyLockedCurrentAffordabilityApproval,
} from "@/lib/affordability/current-approval"
import { verifyCurrentDisbursementEvidence } from "@/lib/affordability/current-disbursement"
import { Prisma } from "@prisma/client"
import { disbursementGuardViolation } from "@/lib/disbursement/guard-violation"
import {
  documentBytesMatchSha256,
  isSha256Digest,
} from "@/lib/documents/content-integrity"
import {
  creditLifeAutoBundleDecision,
  creditLifeAutoBundleElection,
} from "@/lib/insurance/credit-life-containment"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { verifyStoredProviderCountersign } from "@/lib/compliance/provider-countersign"
import { verifyStoredPasqBinding } from "@/lib/compliance/pasq"
import { verifyPasqDocumentArtifact } from "@/lib/compliance/pasq-document.server"
import { getLenderLogo } from "@/lib/config/lender-logo"
import {
  currentVerifiedBankDetails,
  findVerifiedBankStatementForMandate,
  verifyCurrentStoredDebitMandate,
  type DebitMandateApplication,
} from "@/lib/compliance/debit-mandate.server"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import {
  assertDisbursementPreconditions,
  DisbursementPreconditionError,
} from "@/lib/disbursement/preconditions"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"
import { readBorrowerScreening } from "@/lib/screening/gate"

const disbursementApplicationArgs = Prisma.validator<Prisma.LoanApplicationDefaultArgs>()({
  include: {
    product: true,
    client: {
      include: {
        expenseBreakdown: {
          select: {
            id: true,
            updatedAt: true,
            housing: true,
            transport: true,
            food: true,
            education: true,
            insurance: true,
            clothing: true,
            entertainment: true,
            medical: true,
            other: true,
            belowMleJustification: true,
          },
        },
        debtObligations: {
          select: {
            id: true,
            creditProvider: true,
            accountType: true,
            outstandingBalance: true,
            monthlyInstalment: true,
            notes: true,
          },
        },
      },
    },
  },
})

const bureauEvidenceSelect = {
  id: true,
  clientId: true,
  subjectFingerprint: true,
  provider: true,
  createdAt: true,
  score: true,
  riskGrade: true,
  unscoreable: true,
  hasAdverse: true,
  deceased: true,
  underDebtReview: true,
  hasJudgement: true,
  hasNotice: true,
  obligations: true,
} as const

type VerifiedBankStatement = {
  documentId: string
  documentSha256: string
  verifiedAt: string
}
type VerifiedDebitMandate = {
  ok: true
  signedAt: Date
  signatureSha256: string
  documentId: string
  documentSha256: string
  draftDocumentSha256: string
  evidenceSha256: string
  evidence: {
    collectionReference: string
    bankStatement: { documentId: string }
  }
  bankStatement: VerifiedBankStatement
}
type BureauEvidenceCheck = BureauDecisionCheckInput
type BureauEvidenceReader = {
  findFirst: (args: {
    where: {
      tenantId: string
      applicationId: string
      clientId: string
      reviewGeneration: string
      ok: true
      createdAt: { gte: Date }
      provider: "experian"
    }
    orderBy: { createdAt: "desc" }
    select: typeof bureauEvidenceSelect
  }) => Promise<BureauEvidenceCheck | null>
}

function findCurrentBureauEvidence(
  reader: BureauEvidenceReader,
  args: {
    tenantId: string
    applicationId: string
    clientId: string
    reviewGeneration: string | null
  },
): Promise<BureauEvidenceCheck | null> {
  if (!args.reviewGeneration) return Promise.resolve(null)
  return reader.findFirst({
    where: {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      clientId: args.clientId,
      reviewGeneration: args.reviewGeneration,
      ok: true,
      createdAt: { gte: bureauStalenessCutoff() },
      provider: "experian",
    },
    orderBy: { createdAt: "desc" },
    select: bureauEvidenceSelect,
  })
}

const avsEvidenceSelect = {
  clientId: true,
  applicationId: true,
  subjectFingerprint: true,
  passed: true,
} as const

type AvsEvidenceCheck = {
  clientId: string
  applicationId: string | null
  subjectFingerprint: string | null
  passed: boolean
}

type AvsEvidenceReader = {
  findFirst: (args: {
    where: { tenantId: string; clientId: string; applicationId: string }
    orderBy: { createdAt: "desc" }
    select: typeof avsEvidenceSelect
  }) => Promise<AvsEvidenceCheck | null>
}

function findCurrentAvsEvidence(
  reader: AvsEvidenceReader,
  args: { tenantId: string; clientId: string; applicationId: string },
): Promise<AvsEvidenceCheck | null> {
  return reader.findFirst({
    where: args,
    orderBy: { createdAt: "desc" },
    select: avsEvidenceSelect,
  })
}

// Thrown inside the disburse transaction when the atomic status-pinned
// updateMany finds the application already moved off APPROVED (a concurrent
// disburse call won the race). Throwing inside prisma.$transaction rolls
// back the Loan/schedule/commission/bundle work already queued in this tx —
// without this, two concurrent callers could both pass the pre-tx APPROVED
// check and both create a Loan (double payout).
class ApplicationAlreadyDisbursedError extends Error {
  constructor() {
    super("Application status changed before it could be disbursed")
    this.name = "ApplicationAlreadyDisbursedError"
  }
}

class DisbursementEvidenceChangedError extends Error {
  constructor(readonly reason: string) {
    super("Decision evidence changed while disbursement was in progress")
    this.name = "DisbursementEvidenceChangedError"
  }
}

class DisbursementKycError extends Error {
  constructor(
    readonly biometricEvidence: string | null,
    readonly missingDocs: readonly string[],
  ) {
    super("Current composite KYC evidence is not valid for disbursement")
    this.name = "DisbursementKycError"
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Hoisted so the catch can attribute a refusal that arrived as a throw. The
  // in-transaction refusals surface there, and an audit row that cannot name
  // the application or the actor is not worth writing.
  let auditApplicationId: string | undefined
  let auditUser: { id: string; email: string } | undefined
  // Captured INSIDE the tenant context so refusal rows carry it after that
  // context has exited. Without it every row persists with a null tenant, and
  // the audit page and Excel export both filter by an exact tenant id — the
  // rows would exist and be invisible to precisely the people they are for.
  let auditTenantId: string | undefined
  try {
    const { id } = await params
    auditApplicationId = id
    // Fail CLOSED: requireApiRole rejects a null/insufficient session with 401/403.
    // The prior `if (session?.user) {...}` skipped the check entirely when the node
    // session was absent (deactivated staff / bumped tokenVersion whose edge JWT is
    // still valid) — the one route that moves real money must not fall open.
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error
    const { user } = guard
    auditUser = { id: user.id, email: user.email }

    // `return await` (not bare `return`) so a rejection inside the tenant
    // context is caught by the outer try/catch and surfaced as a 500. With
    // `return <promise>`, the outer try block exits before the promise
    // settles, the rejection escapes the catch, and Next.js sees an unhandled
    // rejection — masking the rule that a bundle failure rolls back the disburse.
    // One seam for every refusal this route can produce.
    //
    // All 33 refusal paths carry `disbursementPrecondition`, and NONE of them
    // wrote an audit row: the pre-transaction ones return before any audit
    // write, and the in-transaction ones throw inside prisma.$transaction, so a
    // row queued there is rolled back by the very throw that refuses. An
    // auditor asking "did anyone attempt to pay out against unverified
    // identity?" got silence. Logging HERE — after the handler has returned,
    // outside any transaction — covers all of them, and covers a refusal added
    // later without anyone remembering to log it.
    const response = await withTenantContext(req, async (tenant) => {
      auditTenantId = tenant.id
      // The payout destination is the customer's integrity-bound banking
      // profile from the signed debit mandate. Staff may supply only an
      // optional payment reference here; request-time bank overrides would
      // bypass the customer's authority and are rejected before any other
      // money-path work.
      let bankRequest: { bank?: string; accountNo?: string; branchCode?: string; accountType?: string; bankRef?: string; overrideProof?: string } = {}
      const contentType = req.headers.get("content-type") ?? ""
      if (contentType.includes("application/json")) {
        bankRequest = await req.json() as typeof bankRequest
      }
      if (
        bankRequest.bank !== undefined
        || bankRequest.accountNo !== undefined
        || bankRequest.branchCode !== undefined
        || bankRequest.accountType !== undefined
        || bankRequest.overrideProof !== undefined
      ) {
        return NextResponse.json({
          error: "Cannot disburse to overridden bank details. The payout account must match the customer's verified banking profile and signed debit mandate.",
          disbursementPrecondition: "verified_banking",
        }, { status: 422 })
      }

      const application = await prisma.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        ...disbursementApplicationArgs,
      })

      if (!application) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }
      // Consumer payout path (PASQ, mandate, credit life); asset finance has its own.
      if (!hasClientBorrower(application)) {
        return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
      }

      if (application.status !== "APPROVED") {
        return NextResponse.json(
          { error: "Only approved applications can be disbursed" },
          { status: 400 }
        )
      }

      // A sanctions hit, or a match a periodic re-screen raised after approval,
      // stops the payout. No provider call here; the trigger
      // LoanApplication_a1_guard_screening refuses the DISBURSED write as well.
      const screening = await readBorrowerScreening(tenant.id, { clientId: application.clientId, entityId: null })
      if (!screening.allowed) {
        return NextResponse.json({
          error: `Cannot disburse: ${screening.message}`,
          disbursementPrecondition: "screening",
          screening: screening.state,
        }, { status: 422 })
      }

      // Require signed agreement before disbursement
      if (!application.agreementSignedAt) {
        return NextResponse.json({
          error: "Cannot disburse: Credit agreement has not been signed. Generate and sign the agreement first.",
          disbursementPrecondition: "signed_agreement",
        }, { status: 422 })
      }
      if (
        !application.agreementDocumentId ||
        !isSha256Digest(application.agreementDocumentSha256)
      ) {
        return NextResponse.json({
          error: "Cannot disburse: the signed agreement is missing its document integrity binding. Return the application to review and generate and sign a new agreement.",
          disbursementPrecondition: "signed_agreement",
        }, { status: 422 })
      }
      const providerCountersign = verifyStoredProviderCountersign(application)
      if (!providerCountersign.ok) {
        return NextResponse.json({
          error: "Cannot disburse: the credit provider has not countersigned the exact consumer-signed agreement.",
          disbursementPrecondition: "provider_countersign",
          countersignEvidence: providerCountersign.reason,
        }, { status: 422 })
      }
      const signedAgreementDocument = await prisma.clientDocument.findFirst({
        where: {
          id: application.agreementDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "CREDIT_AGREEMENT",
          fileName: `credit-agreement-${id}.pdf`,
          deletedAt: null,
          verified: true,
          storagePath: { not: null },
        },
        select: { id: true, storagePath: true, contentSha256: true },
      })
      if (
        !signedAgreementDocument?.storagePath ||
        signedAgreementDocument.contentSha256 !== application.agreementDocumentSha256
      ) {
        return NextResponse.json({
          error: "Cannot disburse: the current signed credit-agreement document is missing or invalid.",
          disbursementPrecondition: "signed_agreement",
        }, { status: 422 })
      }
      try {
        const agreementBytes = await readFile(signedAgreementDocument.storagePath)
        if (!documentBytesMatchSha256(
          agreementBytes,
          application.agreementDocumentSha256,
        )) {
          return NextResponse.json({
            error: "Cannot disburse: the signed agreement bytes failed their integrity check. Return the application to review and generate and sign a new agreement.",
            disbursementPrecondition: "signed_agreement",
          }, { status: 422 })
        }
      } catch {
        return NextResponse.json({
          error: "Cannot disburse: the bound signed-agreement bytes are unavailable. Return the application to review and generate and sign a new agreement.",
          disbursementPrecondition: "signed_agreement",
        }, { status: 422 })
      }

      // NCA s.81 second chokepoint: re-assert at disburse that the application
      // had either a current bureau check at approval time OR a dedicated
      // bureau override stamped on `LoanApplication.bureauOverrideAt` by
      // /decide. The dedicated columns (not a text prefix on
      // `recklessLendingNote`) make this a non-forgeable check — LOAN_ADMIN
      // cannot mint an override via the /compliance PATCH endpoint, which
      // only touches reckless-lending fields. Pre-existing APPROVED rows
      // that pre-date the bureau-required gate require a fresh bureau pull
      // (re-trigger /review) or a back-filled override.
      const currentBureauCheck = await findCurrentBureauEvidence(
        prisma.creditBureauCheck as unknown as BureauEvidenceReader,
        {
          tenantId: tenant.id,
          applicationId: id,
          clientId: application.clientId,
          reviewGeneration: application.bureauReviewGeneration,
        },
      )

      const tenantConfig = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          collectionsEngineEnabled: true,
          ndiBufferPct: true,
          bureauMinScore: true,
          bureauBlockAdverse: true,
        },
      })

      const initialApprovalEvidence = verifyCurrentDisbursementEvidence({
        application,
        bureauCheck: currentBureauCheck,
        tenantConfig,
        // Fail-fast only: reject an obviously stale contract before doing the
        // expensive work. The binding judgement is the in-transaction call
        // below, which uses the payout instant.
        at: new Date(),
      })
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "submission_missing") {
        return NextResponse.json({
          error: "Cannot disburse: immutable submission affordability evidence is missing. Return the application to draft and submit, reassess, and approve it again before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "submission_changed") {
        return NextResponse.json({
          error: "Cannot disburse: immutable submission affordability evidence is invalid or has been altered. Return the application to draft and submit, reassess, and approve it again before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "bureau_missing") {
        return NextResponse.json({
          error: "Cannot disburse: NCA s.81 requires a current credit bureau check or a recorded bureau override. Return the application to review and approve it against current bureau evidence before funds can move.",
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "override_incomplete") {
        return NextResponse.json({
          error: "Cannot disburse: the recorded bureau override is incomplete. Return the application to review and record a reasoned override before funds can move.",
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "bureau_simulated") {
        return NextResponse.json({
          error: "Cannot disburse: the bureau check on this application is a simulated result, not valid evidence in this environment. Return the application to review and run a real bureau check before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "kyc_changed") {
        return NextResponse.json({
          error: "Cannot disburse: the client's current KYC status is not verified. Re-complete KYC and approve the application against valid identity evidence before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "composite_kyc",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "compliance_missing") {
        return NextResponse.json({
          error: "Cannot disburse: approval compliance evidence is incomplete. Return the application to review and recapture the pre-agreement acknowledgement, affordability declaration, and reckless-lending assessment.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "acknowledged_pasq",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "mle_justification_missing") {
        return NextResponse.json({
          error: "Cannot disburse: declared living expenses are below the Regulation 23A minimum without a documented justification. Return the application to review and recapture the expense evidence.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "expense_evidence_invalid") {
        return NextResponse.json({
          error: "Cannot disburse: the client's scalar and itemised expense evidence is inconsistent. Return the application to review and repair the financial record.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "debt_evidence_invalid") {
        return NextResponse.json({
          error: "Cannot disburse: the current declared debt evidence is invalid. Return the application to review, repair the debt record, and reassess affordability.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "affordability_failed") {
        return NextResponse.json({
          error: "Cannot disburse: the approved affordability outcome did not pass. Bureau exceptions cannot override a failed affordability assessment.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "contract_missing") {
        return NextResponse.json({
          error: "Cannot disburse: contract schedule evidence is missing. Generate and sign a current agreement before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "signed_agreement",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "contract_changed") {
        return NextResponse.json({
          error: "Cannot disburse: contract schedule evidence is invalid or no longer matches the current agreement. Return the application to review and generate a new agreement.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok && initialApprovalEvidence.reason === "contract_expired") {
        return NextResponse.json({
          error: "Cannot disburse: the signed agreement schedule is no longer current. Return the application to review, generate a current agreement, and obtain a new signature before funds can move.",
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      if (!initialApprovalEvidence.ok) {
        const detail = initialApprovalEvidence.reason === "missing"
          ? "the immutable approval affordability snapshot is missing"
          : "affordability or pricing inputs changed after approval"
        return NextResponse.json({
          error: `Cannot disburse: ${detail}. Return the application to review, reassess affordability, and approve it again before funds can move.`,
          affordabilitySnapshot: initialApprovalEvidence.reason,
          disbursementPrecondition: "unchanged_affordability",
        }, { status: 422 })
      }
      const initialCreditLife = verifyStoredCreditLifeDisclosure(application, {
        principalCents: initialApprovalEvidence.approval.inputs.principalCents,
        termDays: initialApprovalEvidence.approval.inputs.termDays,
      })
      if (!initialCreditLife.ok) {
        return NextResponse.json({
          error: "Cannot disburse: the approved PASQ credit-life disclosure changed.",
          affordabilitySnapshot: "pasq_changed",
          disbursementPrecondition: "insurance_election",
        }, { status: 422 })
      }
      const initialPasq = verifyStoredPasqBinding(application, {
        tenantId: application.tenantId,
        applicationId: application.id,
        clientId: application.clientId,
        productId: application.productId,
        calculatorPricingFingerprint: initialApprovalEvidence.approval.calculator.pricingFingerprint,
        creditLifeDisclosureSha256: initialCreditLife.evidence.disclosureSha256,
        requireApprovalBinding: true,
      })
      if (!initialPasq.ok) {
        return NextResponse.json({
          error: "Cannot disburse: the exact PASQ acknowledged by the client no longer matches approval.",
          affordabilitySnapshot: "pasq_changed",
          disbursementPrecondition: "acknowledged_pasq",
          pasqEvidence: initialPasq.reason,
        }, { status: 422 })
      }
      if (
        initialApprovalEvidence.contract.acceptedPasqDocumentSha256
          !== initialPasq.documentSha256
        || acceptedPasqCalculatorFingerprint(
          initialApprovalEvidence.contract,
        )
          !== initialPasq.evidence.calculator.contractFingerprint
      ) {
        return NextResponse.json({
          error: "Cannot disburse: the signed agreement schedule no longer matches the exact PASQ acknowledged by the client.",
          affordabilitySnapshot: "pasq_changed",
          pasqEvidence: "contract_schedule_changed",
        }, { status: 422 })
      }
      const initialPasqArtifact = await verifyPasqDocumentArtifact(prisma, {
        tenantId: tenant.id,
        clientId: application.clientId,
        documentId: initialPasq.documentId,
        documentSha256: initialPasq.documentSha256,
      })
      if (!initialPasqArtifact.ok) {
        return NextResponse.json({
          error: "Cannot disburse: the approved PASQ PDF bytes failed verification.",
          affordabilitySnapshot: "pasq_changed",
          pasqDocument: initialPasqArtifact.reason,
          disbursementPrecondition: "acknowledged_pasq",
        }, { status: 422 })
      }
      const currentKyc = await readCompositeKycState(
        prisma as unknown as CompositeKycReader,
        {
          tenantId: tenant.id,
          clientId: application.clientId,
          subject: application.client,
          existing: application.client,
          preserveVerifiedProvenance: true,
        },
      )
      if (!currentKyc.ok) {
        return NextResponse.json({
          error: "Cannot disburse: all four core KYC documents plus the current valid biometric attempt, an exact reasoned senior exception, or a recorded in-person verification are required before funds can move.",
          disbursementPrecondition: "composite_kyc",
          biometricEvidence: currentKyc.biometricEvidence,
          missingDocs: currentKyc.missingCoreDocuments,
        }, { status: 422 })
      }

      // Null is treated as debit order for fail-closed compatibility with a
      // pre-migration application object. The migration makes this non-null
      // for every approved/disbursed row.
      const repaymentMethod = application.repaymentMethod ?? "DEBIT_ORDER"
      const mandateRequired = repaymentMethod === "DEBIT_ORDER"
      let initialMandate: VerifiedDebitMandate | null = null
      let initialMandateDocument: { id: string; storagePath: string | null } | null = null
      let initialBankStatement: VerifiedBankStatement

      if (mandateRequired) {
        const mandate = await verifyCurrentStoredDebitMandate(
          prisma as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
          {
            tenantId: tenant.id,
            application: application as unknown as DebitMandateApplication,
            requireSignature: true,
          },
        )
        if (!mandate.ok) {
          const bankingFailure =
            mandate.reason === "bank_details_incomplete"
            || mandate.reason.startsWith("verified_bank_statement")
          return NextResponse.json({
            error: bankingFailure
              ? "Cannot disburse: complete banking details must match a verified, integrity-bound bank statement."
              : "Cannot disburse: the customer has not signed an intact debit mandate for the current banking details and repayment schedule.",
            disbursementPrecondition: bankingFailure
              ? "verified_banking"
              : "signed_debit_mandate",
            debitMandateEvidence: mandate.reason,
          }, { status: 422 })
        }
        initialMandate = mandate
        initialBankStatement = mandate.bankStatement
        initialMandateDocument = await prisma.clientDocument.findFirst({
          where: {
            id: mandate.documentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "DEBIT_MANDATE",
            deletedAt: null,
            verified: true,
            signatureState: "signed",
            signedAt: mandate.signedAt,
            contentSha256: mandate.documentSha256,
            storagePath: { not: null },
          },
          select: { id: true, storagePath: true },
        })
        if (!initialMandateDocument?.storagePath) {
          return NextResponse.json({
            error: "Cannot disburse: the signed debit-mandate document is missing.",
            disbursementPrecondition: "signed_debit_mandate",
            debitMandateEvidence: "signed_document_missing",
          }, { status: 422 })
        }
        try {
          const mandateBytes = await readFile(initialMandateDocument.storagePath)
          if (!documentBytesMatchSha256(
            mandateBytes,
            mandate.documentSha256,
          )) {
            return NextResponse.json({
              error: "Cannot disburse: the signed debit-mandate bytes failed their integrity check.",
              disbursementPrecondition: "signed_debit_mandate",
              debitMandateEvidence: "signed_document_bytes_changed",
            }, { status: 422 })
          }
        } catch {
          return NextResponse.json({
            error: "Cannot disburse: the signed debit-mandate bytes are unavailable.",
            disbursementPrecondition: "signed_debit_mandate",
            debitMandateEvidence: "signed_document_bytes_missing",
          }, { status: 422 })
        }
      } else {
        const bankDetails = currentVerifiedBankDetails(
          application as unknown as DebitMandateApplication,
        )
        if (!bankDetails) {
          return NextResponse.json({
            error: "Cannot disburse: complete banking details must match a verified, integrity-bound bank statement.",
            disbursementPrecondition: "verified_banking",
            bankingEvidence: "bank_details_incomplete",
          }, { status: 422 })
        }
        const bankStatement = await findVerifiedBankStatementForMandate(
          prisma as unknown as Parameters<typeof findVerifiedBankStatementForMandate>[0],
          {
            tenantId: tenant.id,
            clientId: application.clientId,
            bankDetails,
          },
        )
        if (!bankStatement.ok) {
          return NextResponse.json({
            error: "Cannot disburse: complete banking details must match a verified, integrity-bound bank statement.",
            disbursementPrecondition: "verified_banking",
            bankingEvidence: bankStatement.reason,
            // Which leg failed. Without it every cause reads the same on
            // screen and staff cannot tell an unreadable PDF from a statement
            // for a different account.
            bankingEvidenceField: bankStatement.mismatchField,
          }, { status: 422 })
        }
        initialBankStatement = bankStatement.evidence
      }

      // Final shared assertion over the independently verified evidence above.
      // The in-transaction checks repeat these requirements under locks; this
      // preflight spine gives every missing condition a stable 422 reason.
      assertDisbursementPreconditions({
        acknowledged_pasq: {
          ok: initialPasq.ok && initialPasqArtifact.ok,
          evidence: initialPasq.evidence.evidenceSha256,
        },
        signed_agreement: {
          ok: Boolean(
            application.agreementSignedAt
            && signedAgreementDocument.storagePath
            && signedAgreementDocument.contentSha256
              === application.agreementDocumentSha256,
          ),
          evidence: application.agreementDocumentSha256,
        },
        provider_countersign: {
          ok: providerCountersign.ok,
          evidence: providerCountersign.evidence.signatureSha256,
        },
        composite_kyc: {
          ok: currentKyc.ok,
          evidence: currentKyc.biometricEvidence,
        },
        unchanged_affordability: {
          ok: initialApprovalEvidence.ok,
          evidence: initialApprovalEvidence.approval.decisionFingerprint,
        },
        verified_banking: {
          ok: Boolean(initialBankStatement.documentId),
          evidence: initialBankStatement.documentId,
        },
        signed_debit_mandate: {
          ok: !mandateRequired || Boolean(
            initialMandate
            && initialMandateDocument?.storagePath
            && initialMandateDocument.id === initialMandate.documentId,
          ),
          evidence: initialMandate?.documentSha256 ?? "not_required_for_eft",
        },
        insurance_election: {
          ok: initialCreditLife.ok,
          evidence: initialCreditLife.evidence.disclosureSha256,
        },
      })

      let preflightBankDetails
      try {
        preflightBankDetails = resolveDisbursementBankDetails({
          client: {
            bankName: application.client.bankName,
            bankAccountNumber: application.client.bankAccountNumber,
            bankBranchCode: application.client.bankBranchCode,
            accountType: application.client.accountType,
          },
          request: bankRequest,
          hasVerifiedBankStatement: true,
        })
      } catch (error) {
        if (error instanceof DisbursementBankDetailsError) {
          return NextResponse.json({ error: error.message }, { status: 422 })
        }
        throw error
      }
      if (preflightBankDetails.overrideUsed) {
        return NextResponse.json({
          error: "Cannot disburse to overridden bank details. Update and verify the client's banking profile, then run AVS again before funds can move.",
        }, { status: 422 })
      }

      // Phase 7 AVS gate — dark behind TenantConfig.collectionsEngineEnabled.
      // Pre-transaction read (separate from the in-tx referral tenantConfig
      // read below): the gate must block before any state change, and flag-off
      // behavior stays byte-identical (no AVS query at all).
      if (tenantConfig?.collectionsEngineEnabled) {
        const latestAvs = await findCurrentAvsEvidence(
          prisma.avsCheck as unknown as AvsEvidenceReader,
          {
            tenantId: tenant.id,
            clientId: application.clientId,
            applicationId: id,
          },
        )
        const avsGate = evaluateAvsGate(latestAvs, {
          ...application.client,
          bankName: preflightBankDetails.bank,
          bankAccountNumber: preflightBankDetails.accountNo,
          bankBranchCode: preflightBankDetails.branchCode,
          accountType: preflightBankDetails.accountType,
        }, id)
        if (!avsGate.ok) {
          return NextResponse.json({ error: `AVS: ${avsGate.reason}` }, { status: 409 })
        }
      }

      // Bundle credit-life policy alongside the loan inside a single
      // prisma.$transaction so that any failure in the bundle (DB error,
      // unique-constraint trip, ...) rolls back the disburse. Pre-R09b the
      // bundle was a fire-and-forget `void (async () => {})()` that swallowed
      // errors via console.error — meaning a loan could ship without its
      // bundled cover and no caller would know. Under NCA s106 + FAIS, the
      // credit-life exemption only holds if the policy IS bound; an absent
      // policy with a disbursed loan is the worst of both worlds.
      const {
        loan,
        bundle,
        calculation: disbursementCalc,
        maturityDate: disbursementMaturityDate,
      } = await prisma.$transaction(async (tx) => {
        // SERIALIZABLE alone can legally order this transaction before a
        // concurrent Client/Product/policy update even when that update
        // commits first in wall-clock time. Join the same lock protocol as
        // approval/agreement/signing and retain those locks through loan
        // creation and the final application claim.
        const lockedApproval = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
        })
        if (!lockedApproval.ok) {
          throw new DisbursementEvidenceChangedError(lockedApproval.reason)
        }

        // Re-read every decision-bearing row inside the same SERIALIZABLE
        // transaction that creates the loan. The earlier check exists for a
        // useful 422 response, but it is not the money gate: client finances,
        // debts, product pricing, tenant policy, overrides, or a newer bureau
        // row can all change between an HTTP pre-check and payout.
        const txApplication = await tx.loanApplication.findUnique({
          where: { id, tenantId: tenant.id },
          ...disbursementApplicationArgs,
        })
        if (
          !txApplication ||
          !hasClientBorrower(txApplication) ||
          txApplication.status !== "APPROVED" ||
          (txApplication.repaymentMethod ?? "DEBIT_ORDER") !== repaymentMethod ||
          !txApplication.agreementSignedAt ||
          txApplication.agreementDocumentId !== application.agreementDocumentId ||
          txApplication.agreementDocumentSha256 !== application.agreementDocumentSha256
        ) {
          throw new DisbursementEvidenceChangedError("application_state")
        }
        const lockedProviderCountersign = verifyStoredProviderCountersign(txApplication)
        if (
          !lockedProviderCountersign.ok
          || lockedProviderCountersign.evidence.signatureSha256 !== providerCountersign.evidence.signatureSha256
          || lockedProviderCountersign.evidence.envelopeSha256 !== providerCountersign.evidence.envelopeSha256
          || lockedProviderCountersign.evidence.consumerSignatureSha256 !== providerCountersign.evidence.consumerSignatureSha256
          || lockedProviderCountersign.evidence.documentSha256 !== providerCountersign.evidence.documentSha256
          || lockedProviderCountersign.evidence.countersignedAt.toISOString()
            !== providerCountersign.evidence.countersignedAt.toISOString()
        ) {
          throw new DisbursementEvidenceChangedError("provider_countersign_changed")
        }

        // Hold row locks on every currently eligible agreement/bank document
        // until the loan commits. The shared client advisory lock acquired by
        // verifyLockedCurrentAffordabilityApproval coordinates the mutation
        // routes (including the physical-delete boundary); these row locks add
        // database-level protection against any writer that bypasses the HTTP
        // routes.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "ClientDocument"
          WHERE "tenantId" = ${tenant.id}
            AND "clientId" = ${txApplication.clientId}
            AND (
              "docType" = 'SELFIE'::"DocType"
              OR (
                "deletedAt" IS NULL
                AND
                "verified" = true
                AND "docType" IN (
                  'ID_COPY'::"DocType",
                  'PROOF_OF_ADDRESS'::"DocType",
                  'PAYSLIP'::"DocType",
                  'BANK_STATEMENT'::"DocType"
                )
              )
              OR (
                "deletedAt" IS NULL
                AND
                "verified" = true
                AND
                "id" = ${txApplication.agreementDocumentId}
                AND "contentSha256" = ${txApplication.agreementDocumentSha256}
                AND
                "docType" = 'CREDIT_AGREEMENT'::"DocType"
                AND "fileName" = ${`credit-agreement-${id}.pdf`}
                AND "storagePath" IS NOT NULL
              )
              OR (
                "deletedAt" IS NULL
                AND "verified" = true
                AND "id" = ${txApplication.debitMandateDocumentId}
                AND "contentSha256" = ${txApplication.debitMandateDocumentSha256}
                AND "docType" = 'DEBIT_MANDATE'::"DocType"
                AND "signatureState" = 'signed'
                AND "storagePath" IS NOT NULL
              )
            )
          ORDER BY "id"
          FOR SHARE
        `)
        // Lock the exact completed agreement artifact, not merely the
        // application/document rows. Under SERIALIZABLE, FOR SHARE also
        // forces a serialization failure if this transaction fixed its
        // snapshot before a concurrent authorization change committed.
        // The database policy trigger independently repeats this lock so old
        // application images receive the same fail-closed boundary.
        await tx.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "ComplianceRecord"
          WHERE "tenantId" = ${tenant.id}
            AND "type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
            AND "referenceId" = ${id}
            AND "status" = 'COMPLETED'::"ComplianceStatus"
            AND "completedAt" IS NOT NULL
            AND "data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'
            AND "data" ->> 'lifecycle' = 'COMPLETED'
            AND "data" ->> 'applicationId' = ${id}
            AND "data" ->> 'documentId' = ${txApplication.agreementDocumentId}
            AND "data" ->> 'documentSha256' = ${txApplication.agreementDocumentSha256}
          ORDER BY "id"
          FOR SHARE
        `)
        const [
          txBureauCheck,
          txTenantConfig,
          txCompositeKyc,
          txSignedAgreementDocument,
          txAgreementArtifact,
        ] = await Promise.all([
          findCurrentBureauEvidence(
            tx.creditBureauCheck as unknown as BureauEvidenceReader,
            {
              tenantId: tenant.id,
              applicationId: id,
              clientId: txApplication.clientId,
              reviewGeneration: txApplication.bureauReviewGeneration,
            },
          ),
          tx.tenantConfig.findUnique({
            where: { tenantId: tenant.id },
            select: {
              collectionsEngineEnabled: true,
              ndiBufferPct: true,
              bureauMinScore: true,
              bureauBlockAdverse: true,
            },
          }),
          readCompositeKycState(
            tx as unknown as CompositeKycReader,
            {
              tenantId: tenant.id,
              clientId: txApplication.clientId,
              subject: txApplication.client,
              existing: txApplication.client,
              preserveVerifiedProvenance: true,
            },
          ),
          tx.clientDocument.findFirst({
            where: {
              id: txApplication.agreementDocumentId!,
              tenantId: tenant.id,
              clientId: txApplication.clientId,
              docType: "CREDIT_AGREEMENT",
              fileName: `credit-agreement-${id}.pdf`,
              deletedAt: null,
              verified: true,
              storagePath: { not: null },
              contentSha256: txApplication.agreementDocumentSha256!,
            },
            select: { id: true, storagePath: true, contentSha256: true },
          }),
          tx.complianceRecord.findFirst({
            where: {
              tenantId: tenant.id,
              type: "AGREEMENT_ARTIFACT",
              referenceId: id,
              status: "COMPLETED",
              completedAt: { not: null },
              AND: [
                { data: { path: ["kind"], equals: "CREDIT_AGREEMENT_ARTIFACT" } },
                { data: { path: ["lifecycle"], equals: "COMPLETED" } },
                { data: { path: ["applicationId"], equals: id } },
                { data: { path: ["documentId"], equals: txApplication.agreementDocumentId! } },
                { data: { path: ["documentSha256"], equals: txApplication.agreementDocumentSha256! } },
              ],
            },
            select: { data: true },
          }),
        ])
        if (!txCompositeKyc.ok) {
          throw new DisbursementKycError(
            txCompositeKyc.biometricEvidence,
            txCompositeKyc.missingCoreDocuments,
          )
        }
        if (!txSignedAgreementDocument?.storagePath) {
          throw new DisbursementEvidenceChangedError("agreement_document")
        }
        let lockedAgreementBytes: Buffer
        try {
          lockedAgreementBytes = await readFile(txSignedAgreementDocument.storagePath)
        } catch {
          throw new DisbursementEvidenceChangedError("agreement_document_bytes")
        }
        if (!documentBytesMatchSha256(
          lockedAgreementBytes,
          txApplication.agreementDocumentSha256,
        )) {
          throw new DisbursementEvidenceChangedError("agreement_document_bytes")
        }
        // The payout instant, stamped once inside the transaction and reused
        // for every judgement that follows: the evidence check, the contract
        // gate, and the Loan's own startDate. One disbursement is one moment —
        // taking a fresh reading per check let them disagree.
        const disbursedAt = new Date()
        const lockedApprovalEvidence = verifyCurrentDisbursementEvidence({
          application: txApplication,
          bureauCheck: txBureauCheck,
          tenantConfig: txTenantConfig,
          at: disbursedAt,
        })
        if (!lockedApprovalEvidence.ok) {
          throw new DisbursementEvidenceChangedError(lockedApprovalEvidence.reason)
        }
        const lockedCreditLife = verifyStoredCreditLifeDisclosure(txApplication, {
          principalCents: lockedApprovalEvidence.approval.inputs.principalCents,
          termDays: lockedApprovalEvidence.approval.inputs.termDays,
        })
        if (!lockedCreditLife.ok) {
          throw new DisbursementEvidenceChangedError(
            `credit_life_application_${lockedCreditLife.reason}`,
          )
        }
        const lockedPasq = verifyStoredPasqBinding(txApplication, {
          tenantId: txApplication.tenantId,
          applicationId: txApplication.id,
          clientId: txApplication.clientId,
          productId: txApplication.productId,
          calculatorPricingFingerprint: lockedApprovalEvidence.approval.calculator.pricingFingerprint,
          creditLifeDisclosureSha256: lockedCreditLife.evidence.disclosureSha256,
          requireApprovalBinding: true,
        })
        if (
          !lockedPasq.ok
          || lockedPasq.documentId !== initialPasq.documentId
          || lockedPasq.documentSha256 !== initialPasq.documentSha256
          || lockedPasq.evidence.evidenceSha256 !== initialPasq.evidence.evidenceSha256
        ) {
          throw new DisbursementEvidenceChangedError("pasq_changed")
        }
        if (
          lockedApprovalEvidence.contract.acceptedPasqDocumentSha256
            !== lockedPasq.documentSha256
          || acceptedPasqCalculatorFingerprint(
            lockedApprovalEvidence.contract,
          )
            !== lockedPasq.evidence.calculator.contractFingerprint
        ) {
          throw new DisbursementEvidenceChangedError("pasq_contract_schedule_changed")
        }
        const lockedPasqArtifact = await verifyPasqDocumentArtifact(tx, {
          tenantId: tenant.id,
          clientId: txApplication.clientId,
          documentId: lockedPasq.documentId,
          documentSha256: lockedPasq.documentSha256,
          lock: true,
        })
        if (!lockedPasqArtifact.ok) {
          throw new DisbursementEvidenceChangedError("pasq_document_changed")
        }
        const agreementArtifactData =
          txAgreementArtifact?.data
          && typeof txAgreementArtifact.data === "object"
          && !Array.isArray(txAgreementArtifact.data)
            ? txAgreementArtifact.data as Record<string, unknown>
            : null
        const lockedLoanCalc = lockedApprovalEvidence.calculation
        const lockedStartDate = lockedApprovalEvidence.contractStartDate
        if (
          !affordabilityContractCanBeDisbursed(
            lockedApprovalEvidence.contract,
            disbursedAt,
            txApplication.repaymentMethod,
          )
          || disbursedAt.getTime() < lockedStartDate.getTime()
        ) {
          throw new DisbursementEvidenceChangedError("contract_expired")
        }
        // Amounts remain bound to the acknowledged PASQ billing ledger.
        //
        // Dates come from the final agreement calculator the consumer and
        // provider signed, TRANSLATED so the term runs from the day the money
        // reaches them. The signed schedule fixes the intervals — 30 days, then
        // monthly — and payout fixes where those intervals start.
        //
        // Copying the signed dates unshifted would make a late payout shorten
        // the credit period while the interest stays at the disclosed figure:
        // R100 over 29 days instead of 30 is 5.17% a month against an s103 cap
        // of 5%. The same-day gate above currently forces the shift to zero, so
        // this is inert until that gate is retired — but it must be correct
        // before it is, not after.
        if (
          lockedPasq.evidence.billing.schedule.length
            !== lockedLoanCalc.schedule.length
        ) {
          throw new DisbursementEvidenceChangedError(
            "pasq_contract_schedule_changed",
          )
        }
        const agreementScheduleOffsetMs =
          lockedStartDate.getTime()
          - new Date(
            lockedPasq.evidence.calculator.startDate,
          ).getTime()
        // Whole SAST days from the signed schedule's start to actual payout.
        // Zero whenever payout happens on the day the agreement was
        // established, which is every disbursement while the same-day gate
        // stands — so booked dates stay identical to the printed ones today.
        const payoutShiftDays = sastCalendarDaysBetween(
          lockedStartDate,
          disbursedAt,
        )
        const shiftToPayout = (dueDate: Date) =>
          payoutShiftDays === 0
            ? dueDate
            : new Date(dueDate.getTime() + payoutShiftDays * 86_400_000)
        const disbursementCalc = {
          ...lockedLoanCalc,
          totalRepayable: lockedPasq.evidence.billing.totalRepayableCents,
          monthlyInstalment: lockedPasq.evidence.billing.recurringPaymentCents,
          schedule: lockedPasq.evidence.billing.schedule.map((item, index) => {
            const contractItem = lockedLoanCalc.schedule[index]
            if (
              !contractItem
              || contractItem.installmentNo !== item.installmentNo
            ) {
              throw new DisbursementEvidenceChangedError(
                "pasq_contract_schedule_changed",
              )
            }
            return {
              installmentNo: item.installmentNo,
              dueDate: shiftToPayout(contractItem.dueDate),
              principalDue: item.principalDueCents,
              interestDue: item.interestDueCents,
              creditLifePremiumDue: item.creditLifePremiumDueCents,
              feesDue: item.feesDueCents,
              totalDue: item.totalDueCents,
              openingBalance: item.openingBalanceCents,
              closingBalance: item.closingBalanceCents,
            }
          }),
        }
        const lockedMaturityDate = disbursementCalc.schedule.at(-1)?.dueDate ?? (() => {
          const fallback = new Date(disbursedAt)
          fallback.setDate(
            fallback.getDate() +
              (txApplication.approvedTermDays ?? txApplication.appliedTermDays),
          )
          return fallback
        })()
        let lockedBankDetails
        try {
          lockedBankDetails = resolveDisbursementBankDetails({
            client: {
              bankName: txApplication.client.bankName,
              bankAccountNumber: txApplication.client.bankAccountNumber,
              bankBranchCode: txApplication.client.bankBranchCode,
              accountType: txApplication.client.accountType,
            },
            request: bankRequest,
            hasVerifiedBankStatement: true,
          })
        } catch (error) {
          if (error instanceof DisbursementBankDetailsError) {
            throw new DisbursementEvidenceChangedError("bank_details")
          }
          throw error
        }
        if (lockedBankDetails.overrideUsed) {
          throw new DisbursementEvidenceChangedError("bank_details")
        }

        let lockedMandate: VerifiedDebitMandate | null = null
        let lockedBankStatement: VerifiedBankStatement
        if (mandateRequired) {
          const mandate = await verifyCurrentStoredDebitMandate(
            tx as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
            {
              tenantId: tenant.id,
              application: txApplication as unknown as DebitMandateApplication,
              requireSignature: true,
            },
          )
          if (
            !mandate.ok
            || !initialMandate
            || mandate.documentId !== initialMandate.documentId
            || mandate.documentSha256 !== initialMandate.documentSha256
            || mandate.signatureSha256 !== initialMandate.signatureSha256
            || mandate.evidenceSha256 !== initialMandate.evidenceSha256
          ) {
            throw new DisbursementEvidenceChangedError(
              mandate.ok
                ? "debit_mandate_changed"
                : `debit_mandate_${mandate.reason}`,
            )
          }
          lockedMandate = mandate
          lockedBankStatement = mandate.bankStatement
          const txMandateDocument = await tx.clientDocument.findFirst({
            where: {
              id: mandate.documentId,
              tenantId: tenant.id,
              clientId: txApplication.clientId,
              docType: "DEBIT_MANDATE",
              deletedAt: null,
              verified: true,
              signatureState: "signed",
              signedAt: mandate.signedAt,
              contentSha256: mandate.documentSha256,
              storagePath: { not: null },
            },
            select: { id: true, storagePath: true },
          })
          if (!txMandateDocument?.storagePath) {
            throw new DisbursementEvidenceChangedError("debit_mandate_document")
          }
          let lockedMandateBytes: Buffer
          try {
            lockedMandateBytes = await readFile(txMandateDocument.storagePath)
          } catch {
            throw new DisbursementEvidenceChangedError("debit_mandate_document_bytes")
          }
          if (!documentBytesMatchSha256(
            lockedMandateBytes,
            mandate.documentSha256,
          )) {
            throw new DisbursementEvidenceChangedError("debit_mandate_document_bytes")
          }
        } else {
          const bankDetails = currentVerifiedBankDetails(
            txApplication as unknown as DebitMandateApplication,
          )
          if (!bankDetails) {
            throw new DisbursementEvidenceChangedError("bank_details")
          }
          const bankStatement = await findVerifiedBankStatementForMandate(
            tx as unknown as Parameters<typeof findVerifiedBankStatementForMandate>[0],
            {
              tenantId: tenant.id,
              clientId: txApplication.clientId,
              bankDetails,
              documentId: initialBankStatement.documentId,
            },
          )
          if (
            !bankStatement.ok
            || bankStatement.evidence.documentId !== initialBankStatement.documentId
            || bankStatement.evidence.documentSha256 !== initialBankStatement.documentSha256
            || bankStatement.evidence.verifiedAt !== initialBankStatement.verifiedAt
          ) {
            throw new DisbursementEvidenceChangedError(
              bankStatement.ok
                ? "verified_bank_statement_changed"
                : bankStatement.reason,
            )
          }
          lockedBankStatement = bankStatement.evidence
        }

        if (txTenantConfig?.collectionsEngineEnabled) {
          const txLatestAvs = await findCurrentAvsEvidence(
            tx.avsCheck as unknown as AvsEvidenceReader,
            {
              tenantId: tenant.id,
              clientId: txApplication.clientId,
              applicationId: id,
            },
          )
          const txAvsGate = evaluateAvsGate(
            txLatestAvs,
            {
              ...txApplication.client,
              bankName: lockedBankDetails.bank,
              bankAccountNumber: lockedBankDetails.accountNo,
              bankBranchCode: lockedBankDetails.branchCode,
              accountType: lockedBankDetails.accountType,
            },
            id,
          )
          if (!txAvsGate.ok) {
            throw new DisbursementEvidenceChangedError("avs")
          }
        }

        const newLoan = await tx.loan.create({
          data: {
            tenantId: tenant.id,
            reference: lockedMandate?.evidence.collectionReference ?? generateReference("LN"),
            applicationId: txApplication.id,
            clientId: txApplication.clientId,
            productId: txApplication.productId,
            principal: disbursementCalc.principal,
            totalInterest: disbursementCalc.totalInterest,
            initiationFee: disbursementCalc.initiationFee,
            creditLifePremiums:
              lockedPasq.evidence.creditLife.totalPremiumCents,
            totalRepayable: disbursementCalc.totalRepayable,
            contractualTotalInterest: disbursementCalc.totalInterest,
            contractualTotalRepayable: disbursementCalc.totalRepayable,
            outstandingPrincipal: disbursementCalc.principal,
            status: "ACTIVE",
            startDate: disbursedAt,
            maturityDate: lockedMaturityDate,
            nextPaymentDate: disbursementCalc.schedule[0]?.dueDate || lockedMaturityDate,
            interestRatePm: lockedApprovalEvidence.approval.inputs.interestRatePm,
            interestModel: lockedApprovalEvidence.approval.inputs.interestModel,
            monthlyServiceFee: lockedApprovalEvidence.approval.inputs.monthlyServiceFeeCents,
            agreementDocId: txSignedAgreementDocument.id,
          },
        })

        // Create repayment schedule
        await tx.repaymentSchedule.createMany({
          data: disbursementCalc.schedule.map((item) => ({
            tenantId: tenant.id,
            loanId: newLoan.id,
            installmentNo: item.installmentNo,
            dueDate: item.dueDate,
            principalDue: item.principalDue,
            interestDue: item.interestDue,
            creditLifePremiumDue: item.creditLifePremiumDue,
            feesDue: item.feesDue,
            totalDue: item.totalDue,
            status: "PENDING",
          })),
        })

        // Referral agent commission — accrue for a referred, active-agent loan.
        // No-ops unless the borrower is attributed to an active code+agent with a
        // rate > 0. Runs in-tx so a real DB error rolls back the disbursement.
        await recordDisbursementCommission(tx, {
          tenantId: tenant.id,
          loanId: newLoan.id,
          clientId: txApplication.clientId,
          principalCents: newLoan.principal,
        })

        // Update application status + banking details. Guard against the
        // read-then-write race: two concurrent disburse calls can both pass
        // the pre-tx `application.status !== "APPROVED"` check above.
        // `updateMany` pinning `status: "APPROVED"` atomically refuses the
        // second writer; throwing on count !== 1 rolls back the loan +
        // schedule + commission already created above in this transaction.
        const claimed = await tx.loanApplication.updateMany({
          where: {
            id: txApplication.id,
            tenantId: tenant.id,
            status: "APPROVED",
            repaymentMethod,
            updatedAt: txApplication.updatedAt,
            agreementDocumentId: txSignedAgreementDocument.id,
            agreementDocumentSha256: txApplication.agreementDocumentSha256,
            agreementCountersignedAt: lockedProviderCountersign.evidence.countersignedAt,
            agreementCountersignatureSha256: lockedProviderCountersign.evidence.signatureSha256,
            agreementCountersignatureEnvelopeSha256: lockedProviderCountersign.evidence.envelopeSha256,
            agreementCountersignedDocumentSha256: lockedProviderCountersign.evidence.documentSha256,
            ...(lockedMandate ? {
              debitMandateSignedAt: lockedMandate.signedAt,
              debitMandateSignatureSha256: lockedMandate.signatureSha256,
              debitMandateDocumentId: lockedMandate.documentId,
              debitMandateDocumentSha256: lockedMandate.documentSha256,
            } : {}),
          },
          data: {
            status: "DISBURSED",
            disbursedAt,
            disbursementBank: lockedBankDetails.bank,
            disbursementAccountNo: lockedBankDetails.accountNo,
            disbursementBranchCode: lockedBankDetails.branchCode,
            disbursementAccountType: lockedBankDetails.accountType,
            disbursementRef: lockedBankDetails.bankRef,
          },
        })
        if (claimed.count !== 1) {
          throw new ApplicationAlreadyDisbursedError()
        }

        // Auto-create CREDIT_LIFE bundle if eligible.
        // Belt-and-braces — the agreementSignedAt invariant is already
        // enforced upstream (early return ~line 53). Re-asserting at the
        // bundle site means a future refactor that moves the bundle out of
        // this route can't accidentally drop the precondition. The FAIS
        // bundled-exemption (NCA s106) relies on the policy being part of a
        // signed credit agreement; bundling without a signed agreement would
        // be a regulatory misstatement.
        if (!txApplication.agreementSignedAt) {
          throw new Error(
            "Bundle invariant violated: reached credit-life bundle code with application.agreementSignedAt = null. " +
            "The upstream signed-agreement gate should have blocked this disburse. Refusing to bundle."
          )
        }

        type BundleResult =
          | { kind: "bundled"; policyId: string }
          | { kind: "skipped"; reason: "feature_disabled" | "agreement_not_bound" | "below_threshold" }

        let bundle: BundleResult
        const agreementElection = creditLifeAutoBundleElection(
          txAgreementArtifact?.data,
        )
        if (!agreementElection.resolved) {
          throw new DisbursementEvidenceChangedError("credit_life_agreement_election_missing")
        }
        if (
          !agreementArtifactData
          || agreementArtifactData.creditLifeElection !== lockedCreditLife.evidence.election
          || agreementArtifactData.creditLifeProductId !== lockedCreditLife.evidence.productId
          || agreementArtifactData.creditLifeProductName !== lockedCreditLife.evidence.productName
          || agreementArtifactData.creditLifeInsurerId !== lockedCreditLife.evidence.insurerId
          || agreementArtifactData.creditLifeInsurerName !== lockedCreditLife.evidence.insurerName
          || agreementArtifactData.creditLifeMonthlyPremiumCents !== lockedCreditLife.evidence.monthlyPremiumCents
          || agreementArtifactData.creditLifeDisclosureVersion !== lockedCreditLife.evidence.version
          || agreementArtifactData.creditLifeDisclosureSha256 !== lockedCreditLife.evidence.disclosureSha256
        ) {
          throw new DisbursementEvidenceChangedError("credit_life_agreement_evidence_changed")
        }
        if (
          agreementElection.eligible
          && lockedCreditLife.evidence.election !== "ACCEPTED"
        ) {
          throw new DisbursementEvidenceChangedError("credit_life_agreement_election_changed")
        }
        if (!agreementElection.eligible) {
          // The signed artifact is authoritative. The live flag is used only
          // to explain why a non-binding agreement skipped cover; it may never
          // cancel cover already promised in the signed document.
          const currentDecision = creditLifeAutoBundleDecision(lockedLoanCalc.principal)
          bundle = {
            kind: "skipped",
            reason: currentDecision.eligible
              ? "agreement_not_bound"
              : currentDecision.reason,
          }
        } else {
          // Bundled cover must name a product and insurer. Null here means the
          // application recorded that no cover was offered, which can only be a
          // decline -- reaching this branch at all would be a corrupted record.
          const bundledProductId = lockedCreditLife.evidence.productId
          const bundledProductName = lockedCreditLife.evidence.productName
          const bundledInsurerId = lockedCreditLife.evidence.insurerId
          const bundledInsurerName = lockedCreditLife.evidence.insurerName
          if (
            bundledProductId === null
            || bundledProductName === null
            || bundledInsurerId === null
            || bundledInsurerName === null
          ) {
            throw new DisbursementEvidenceChangedError(
              "credit_life_product_unavailable",
            )
          }
          const lockedOfferRows = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
              SELECT product."id"
              FROM "InsuranceProduct" AS product
              JOIN "Insurer" AS insurer
                ON insurer."id" = product."insurerId"
                AND insurer."tenantId" = product."tenantId"
              WHERE product."id" = ${bundledProductId}
                AND product."tenantId" = ${tenant.id}
                AND product."name" = ${bundledProductName}
                AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
                AND product."active" = TRUE
                AND insurer."id" = ${bundledInsurerId}
                AND insurer."tenantId" = ${tenant.id}
                AND insurer."name" = ${bundledInsurerName}
                AND insurer."active" = TRUE
              FOR SHARE OF product, insurer
            `,
          )
          if (
            lockedOfferRows.length !== 1
            || lockedOfferRows[0].id !== bundledProductId
          ) {
            throw new DisbursementEvidenceChangedError(
              "credit_life_product_unavailable",
            )
          }
          const creditLifeProduct = await tx.insuranceProduct.findFirst({
            where: {
              id: bundledProductId,
              tenantId: tenant.id,
              name: bundledProductName,
              type: "CREDIT_LIFE",
              active: true,
              insurerId: bundledInsurerId,
              insurer: {
                is: {
                  id: bundledInsurerId,
                  tenantId: tenant.id,
                  name: bundledInsurerName,
                  active: true,
                },
              },
            },
            select: { id: true, insurerId: true, commissionRate: true },
          })

          if (!creditLifeProduct) {
            throw new DisbursementEvidenceChangedError("credit_life_product_unavailable")
          } else {
            // Credit Life Insurance Regulations, 2017, Reg 3(1): for an
            // unsecured / short-term credit transaction the credit-life premium
            // may not exceed R4.50 per R1 000 of the deferred amount per month
            // (= 0.0045 of the principal). Cap the premium at that ceiling so it
            // is lawful AND the agreement's Reg 3(1) disclosure ("does not
            // exceed the maximum prescribed") is true. The previous flat
            // 1% (R10/R1 000) was over the cap by ~2.2x.
            const premiumAmount =
              lockedCreditLife.evidence.monthlyPremiumCents / 100
            // Record the underwriter + commission so the bundled policy is a
            // complete record: a Credit Life policy with no insurer
            // or commission fails the Credit Life Regulations 2017 / FAIS
            // expectations. The underwriter is the one configured on the Credit
            // Life product; commission is the product's rate on the (monthly)
            // premium. If the product has no underwriter configured, insurerId
            // stays null — the bundle still binds (disbursement is never blocked).
            //
            // PPR is deliberately NOT stamped here. pprIssuedAt asserts a
            // Policyholder-Protection disclosure was issued to the client, which
            // requires an actual disclosure document + officer action via the
            // dedicated PPR flow. Auto-stamping it would be a false compliance
            // claim (needs legal sign-off); the policy correctly reads "Not yet
            // issued" until that flow runs.
            const commissionRate = creditLifeProduct.commissionRate
            const commissionAmount = Number((premiumAmount * Number(commissionRate)).toFixed(2))
            const created = await tx.insurancePolicy.create({
              data: {
                tenantId: tenant.id,
                policyNumber: generateReference("CL"),
                clientId: txApplication.clientId,
                type: "CREDIT_LIFE",
                status: "ACTIVE",
                premiumAmount,
                sumAssured: newLoan.outstandingPrincipal / 100,
                linkedLoanId: newLoan.id,
                startDate: disbursedAt,
                renewalDate: lockedMaturityDate,
                productId: creditLifeProduct.id,
                insurerId: creditLifeProduct.insurerId,
                commissionRate,
                commissionAmount,
                policySource: "BUNDLED_CREDIT_AGREEMENT",
                faisDisclosureAt: null,
                faisDisclosurePdfUrl: null,
              },
              select: { id: true },
            })
            bundle = { kind: "bundled", policyId: created.id }
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.LOAN_CREATED,
            entity: "Loan",
            entityId: newLoan.id,
            newValue: {
              reference: newLoan.reference,
              applicationId: txApplication.id,
              clientId: txApplication.clientId,
              productId: txApplication.productId,
              principal: disbursementCalc.principal,
              totalInterest: disbursementCalc.totalInterest,
              initiationFee: disbursementCalc.initiationFee,
              serviceFees: disbursementCalc.serviceFees,
              creditLifePremiums:
                lockedPasq.evidence.creditLife.totalPremiumCents,
              totalRepayable: disbursementCalc.totalRepayable,
              disbursementAmount: disbursementCalc.disbursementAmount,
              termDays: lockedApprovalEvidence.approval.inputs.termDays,
              interestRatePm: lockedApprovalEvidence.approval.inputs.interestRatePm,
              interestModel: lockedApprovalEvidence.approval.inputs.interestModel,
              signedScheduleStartDate: lockedStartDate.toISOString(),
              startDate: disbursedAt.toISOString(),
              agreementScheduleOffsetMs,
              payoutShiftDays,
              maturityDate: lockedMaturityDate.toISOString(),
              scheduleItems: disbursementCalc.schedule.length,
            },
          },
        })

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.LOAN_DISBURSED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              loanId: newLoan.id,
              loanRef: newLoan.reference,
              principal: newLoan.principal,
              agreementDocumentId: txSignedAgreementDocument.id,
              agreementDocumentSha256: txApplication.agreementDocumentSha256,
              agreementCountersignedAt: lockedProviderCountersign.evidence.countersignedAt.toISOString(),
              agreementCountersignedById: lockedProviderCountersign.evidence.countersignedById,
              agreementCountersignedByName: lockedProviderCountersign.evidence.countersignedByName,
              agreementCountersignatureSha256: lockedProviderCountersign.evidence.signatureSha256,
              agreementCountersignatureEnvelopeSha256: lockedProviderCountersign.evidence.envelopeSha256,
              agreementConsumerSignatureSha256: lockedProviderCountersign.evidence.consumerSignatureSha256,
              agreementCountersignedDocumentSha256: lockedProviderCountersign.evidence.documentSha256,
              pasqDocumentId: lockedPasq.documentId,
              pasqDocumentSha256: lockedPasq.documentSha256,
              pasqEvidenceSha256: lockedPasq.evidence.evidenceSha256,
              bankOverrideUsed: lockedBankDetails.overrideUsed,
              bankOverrideProof: lockedBankDetails.overrideProof,
              repaymentMethod,
              bankStatementDocumentId: lockedBankStatement.documentId,
              ...(lockedMandate ? {
                debitMandateDocumentId: lockedMandate.documentId,
                debitMandateDocumentSha256: lockedMandate.documentSha256,
                debitMandateDraftSha256: lockedMandate.draftDocumentSha256,
                debitMandateEvidenceSha256: lockedMandate.evidenceSha256,
                debitMandateSignatureSha256: lockedMandate.signatureSha256,
                debitMandateSignedAt: lockedMandate.signedAt.toISOString(),
              } : {}),
            },
          },
        })
        if (bundle.kind === "bundled") {
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: user.id,
              userEmail: user.email,
              action: AuditAction.INSURANCE_POLICY_AUTOBUNDLED,
              entity: "InsurancePolicy",
              entityId: bundle.policyId,
              newValue: {
                policyId: bundle.policyId,
                linkedLoanId: newLoan.id,
                agreementSignedAt: txApplication.agreementSignedAt,
              },
            },
          })
        } else {
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: user.id,
              userEmail: user.email,
              action: AuditAction.INSURANCE_AUTOBUNDLE_SKIPPED,
              entity: "Loan",
              entityId: newLoan.id,
              newValue: {
                reason: bundle.reason,
                appliedAmount: disbursementCalc.principal,
              },
            },
          })
        }

        // The database guard is DEFERRABLE so every supported transaction
        // order can create the loan, transition the application, and bind the
        // elected policy atomically. Force that invariant to run before this
        // callback returns: PostgreSQL still protects rollback/legacy writers
        // at COMMIT, while the current API receives a statement-level failure
        // that Prisma cannot report as a successful disbursement.
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")

        return {
          loan: newLoan,
          bundle,
          calculation: disbursementCalc,
          maturityDate: lockedMaturityDate,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      if (bundle.kind === "bundled") {
        // issue + track the FAIS / PPR product disclosure for the
        // auto-bundled credit-life policy. The substantive Credit Life
        // Insurance Regulations 2017 disclosure (G2) is already in the signed
        // credit agreement; here we additionally generate the FAIS intermediary
        // disclosure (G1 — FSP identity, PI cover, cooling-off, FAIS Ombud) as
        // the policyholder's standalone record, link it, and stamp pprIssuedAt
        // ONLY once that artifact actually exists (no false "issued" timestamp).
        // Post-commit + failure-tolerant: a disclosure failure must NOT roll
        // back the disburse — the loan, the bound cover and the signed G2
        // disclosure all remain valid, and the manual PPR flow can backfill.
        // Tracks a created disclosure ClientDocument so the catch can soft-delete
        // it if the subsequent policy stamp fails (avoids an orphaned, unlinked
        // disclosure row + leaked file).
        let disclosureDocId: string | null = null
        try {
          const policy = await prisma.insurancePolicy.findUnique({
            where: { id: bundle.policyId, tenantId: tenant.id },
            include: { product: true, insurer_rel: true, client: true },
          })
          if (policy) {
            // Throws when the lender identity is unconfigured; the catch below
            // then leaves the disclosure unissued rather than printing another
            // provider's FSP number on it.
            const identity = await getLenderIdentity(tenant.id)
            const pdf = await generateFaisDisclosurePdf({
              lender: identity,
              logo: await getLenderLogo(tenant.id),
              client: { firstName: policy.client.firstName, lastName: policy.client.lastName, idNumber: policy.client.idNumber },
              advisor: {
                name: user.name ?? user.email ?? "Credit Officer",
                designation: "Credit Officer",
              },
              product: {
                type: "CREDIT_LIFE",
                name: policy.product?.name ?? "Credit Life",
                insurer: policy.insurer_rel?.name ?? policy.insurer ?? undefined,
              },
              // premiumAmount / sumAssured are stored in RANDS on InsurancePolicy;
              // generateFaisDisclosurePdf expects rands (it converts to cents).
              policyDraft: { sumAssured: Number(policy.sumAssured), premiumAmount: Number(policy.premiumAmount) },
            })
            const { storagePath, fileSize } = await saveFile(pdf, "application/pdf")
            const disclosureDoc = await prisma.clientDocument.create({
              data: {
                tenantId: tenant.id,
                clientId: policy.clientId,
                docType: "OTHER",
                fileName: `fais-disclosure-${policy.policyNumber}.pdf`,
                fileUrl: "",
                storagePath,
                fileSize,
                mimeType: "application/pdf",
                uploadedByType: "staff",
                uploadedById: user.id,
                extractionStatus: "skipped",
                verified: false,
              },
              select: { id: true },
            })
            disclosureDocId = disclosureDoc.id
            const issuedAt = new Date()
            await prisma.insurancePolicy.update({
              where: { id: policy.id, tenantId: tenant.id },
              data: {
                faisDisclosureAt: issuedAt,
                faisDisclosurePdfUrl: `/api/documents/${disclosureDoc.id}/view`,
                pprIssuedAt: issuedAt,
              },
            })
            await logAudit({
              tenantId: tenant.id,
              userId: user.id,
              userEmail: user.email,
              action: AuditAction.INSURANCE_PPR_ISSUED,
              entity: "InsurancePolicy",
              entityId: policy.id,
              newValue: { policyId: policy.id, disclosureDocId: disclosureDoc.id, pprIssuedAt: issuedAt },
            })
          }
        } catch (err) {
          // Disclosure generation failed — policy is bound and the signed
          // credit agreement already carried the G2 disclosure; pprIssuedAt
          // stays null ("Not yet issued") for the manual PPR flow to complete.
          console.error("[disburse] FAIS/PPR disclosure issuance failed:", err)
          // If the document was created but the policy stamp failed, it is now
          // orphaned (not linked to any policy) — soft-delete it so it neither
          // leaks nor surfaces in the client's document list.
          if (disclosureDocId) {
            await prisma.clientDocument
              .update({ where: { id: disclosureDocId }, data: { deletedAt: new Date() } })
              .catch(() => {})
          }
          await logAudit({
            tenantId: tenant.id,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.INSURANCE_PPR_ISSUE_FAILED,
            entity: "InsurancePolicy",
            entityId: bundle.policyId,
            newValue: { policyId: bundle.policyId, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      // Trigger loan_disbursed notification (fire-and-forget). `amount` is
      // the amount the consumer actually receives — equals principal in
      // DEFERRED mode, or principal minus the initiation fee in UPFRONT
      // mode; loan.principal would overstate what an UPFRONT consumer got.
      // Passed via `data` because lib/notifications.ts's loan_disbursed
      // branch has no DB-backed source for amount/dueDate (unlike
      // reference, which it fetches directly) — this is that source,
      // reusing the schedule already computed above rather than
      // re-deriving it.
      const firstPaymentDate = disbursementCalc.schedule[0]?.dueDate
        ? new Intl.DateTimeFormat("en-ZA").format(new Date(disbursementCalc.schedule[0].dueDate))
        : new Intl.DateTimeFormat("en-ZA").format(disbursementMaturityDate)
      triggerNotification({
        tenantId: tenant.id,
        event: "loan_disbursed",
        loanId: loan.id,
        data: { amount: disbursementCalc.disbursementAmount, dueDate: firstPaymentDate },
      }).catch(() => {})

      // Return JSON for fetch() calls, redirect for form POST
      const contentType2 = req.headers.get("content-type") ?? ""
      if (contentType2.includes("application/json")) {
        return NextResponse.json({ success: true, loanId: loan.id, loanRef: loan.reference })
      }
      return NextResponse.redirect(
        new URL(`/loans/${loan.id}`, req.url),
        303
      )
    }) // end withTenantContext

    // Every refusal, recorded once, outside any transaction it aborted.
    const refusal = await refusalReasonFrom(response, "disbursementPrecondition")
    if (refusal) {
      await auditRefusal({
        action: AuditAction.LOAN_DISBURSEMENT_REFUSED,
        entity: "LoanApplication",
        entityId: id,
        tenantId: auditTenantId,
        userId: user.id,
        userEmail: user.email,
        reason: refusal.reason,
        status: refusal.status,
      })
    }
    return response
  } catch (error) {
    // The in-transaction refusals arrive HERE, as typed throws the transaction
    // has already rolled back — which is exactly why the audit row must be
    // written from this point and not from inside the transaction that refused.
    if (
      error instanceof DisbursementPreconditionError ||
      error instanceof DisbursementKycError ||
      error instanceof DisbursementEvidenceChangedError
    ) {
      // The evidence-changed 409 is a compliance refusal too: the agreement
      // bytes, affordability evidence, bank details or mandate moved between
      // approval and payout. It refuses a disbursement for a regulated reason
      // and belongs in the same trail as the 422s.
      const [reason, status] =
        error instanceof DisbursementKycError
          ? (["composite_kyc", 422] as const)
          : error instanceof DisbursementEvidenceChangedError
            ? ([`evidence_changed:${error.reason}`, 409] as const)
            : ([error.precondition, 422] as const)
      await auditRefusal({
        action: AuditAction.LOAN_DISBURSEMENT_REFUSED,
        entity: "LoanApplication",
        entityId: auditApplicationId ?? "unknown",
        tenantId: auditTenantId,
        userId: auditUser?.id,
        userEmail: auditUser?.email,
        reason,
        status,
      })
    }
    if (error instanceof DisbursementPreconditionError) {
      return NextResponse.json(
        {
          error: `Cannot disburse: ${error.message}`,
          disbursementPrecondition: error.precondition,
          preconditionEvidence: error.evidence,
        },
        { status: 422 },
      )
    }
    if (error instanceof DisbursementKycError) {
      return NextResponse.json(
        {
          error: "Cannot disburse: all four core KYC documents plus the current valid biometric attempt, an exact reasoned senior exception, or a recorded in-person verification are required before funds can move.",
          disbursementPrecondition: "composite_kyc",
          biometricEvidence: error.biometricEvidence,
          missingDocs: error.missingDocs,
        },
        { status: 422 },
      )
    }
    if (
      error instanceof DisbursementEvidenceChangedError ||
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
    ) {
      return NextResponse.json(
        {
          error: "Application or decision evidence changed while disbursement was in progress; no funds moved. Refresh, reassess, and try again.",
          ...(error instanceof DisbursementEvidenceChangedError
            ? { affordabilitySnapshot: error.reason }
            : {}),
        },
        { status: 409 },
      )
    }
    if (error instanceof ApplicationAlreadyDisbursedError) {
      return NextResponse.json(
        { error: "Application status changed before it could be disbursed; refresh and try again." },
        { status: 409 }
      )
    }
    // The payout guards are enforced TWICE: as preflight preconditions here in
    // TypeScript, and again as BEFORE-trigger RAISE ... ERRCODE 23514 on the
    // DISBURSED status write. The second layer is deliberate defence in depth,
    // but it arrives as a raw database error, which would answer a REFUSED
    // payout with the same bare 500 a system failure gives. An operator could not
    // tell "evidence is missing" from "the system is broken", and the guard's
    // own sentence — which names the missing evidence — would be discarded.
    //
    // Matched on the guards' message text rather than on a Prisma error class:
    // Prisma wraps a trigger-raised error in different classes depending on how
    // the statement was issued. The prefix is emitted by ten disbursement
    // guards and nowhere else in the schema, so it cannot mislabel an unrelated
    // failure as a refusal.
    const guardRefusal = disbursementGuardViolation(error)
    if (guardRefusal) {
      console.warn("Disbursement refused by a database guard:", guardRefusal)
      return NextResponse.json(
        {
          error: guardRefusal,
          disbursementGuard: "database_guard_refused",
        },
        { status: 422 },
      )
    }
    console.error("Failed to disburse loan:", error)
    return NextResponse.json(
      { error: "Failed to disburse loan" },
      { status: 500 }
    )
  }
}
