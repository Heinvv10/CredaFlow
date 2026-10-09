import { randomUUID } from "node:crypto"
import { NextResponse, type NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { requireApiRole, requireOwnerOrStaff } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import {
  calculateLoanFromDecisionInputs,
  createAffordabilityCalculatorEvidence,
  frozenApprovedTerms,
} from "@/lib/affordability/snapshot"
import {
  readCompositeKycState,
  type CompositeKycReader,
} from "@/lib/kyc/document-state"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import { creditLifeAutoBundleDecision } from "@/lib/insurance/credit-life-containment"
import {
  createPasqEvidence,
  pasqEvidenceIsIntact,
  PASQ_VERSION,
} from "@/lib/compliance/pasq"
import { generateCreditAgreementPdf } from "@/lib/pdf/creditAgreement"
import { ceremonyMarkerFor } from "@/lib/pdf/agreement-render-input"
import {
  deleteManagedFileStrict,
  managedStoragePath,
  readFile,
  saveFileToManagedPath,
} from "@/lib/storage"
import {
  documentBytesMatchSha256,
  isSha256Digest,
  sha256DocumentBytes,
} from "@/lib/documents/content-integrity"
import { AuditAction } from "@/lib/audit"
import {
  lockCurrentStatutoryProviderIdentity,
  statutoryProviderIdentityFromTenant,
  type StatutoryProviderIdentity,
} from "@/lib/compliance/statutory-provider-identity.server"
import { quotationValidUntilDateFromDatabase } from "@/lib/compliance/sa-business-calendar.server"
import { getLenderLogo } from "@/lib/config/lender-logo"

type RouteCtx = { params: Promise<{ id: string }> }

const PASQ_ARTIFACT_KIND = "PASQ_ARTIFACT"
const STAGING_LEASE_MS = 15 * 60 * 1000

interface PasqManifest {
  kind: typeof PASQ_ARTIFACT_KIND
  lifecycle: "STAGING" | "RECONCILING" | "COMPLETED" | "FAILED"
  applicationId: string
  documentId: string
  documentSha256: string
  evidenceSha256: string
  storagePath: string
  fileName: string
  fileSize: number
  stagedAt: string
  completedAt?: string
  failedAt?: string
  failureReason?: string
}

function artifactKey(tenantId: string, applicationId: string): string {
  return `pasq-artifact:${tenantId}:${applicationId}`
}

function readPasqManifest(value: unknown): PasqManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const manifest = value as Partial<PasqManifest>
  if (
    manifest.kind !== PASQ_ARTIFACT_KIND
    || !["STAGING", "RECONCILING", "COMPLETED", "FAILED"].includes(manifest.lifecycle ?? "")
    || typeof manifest.applicationId !== "string"
    || typeof manifest.documentId !== "string"
    || !isSha256Digest(manifest.documentSha256)
    || !isSha256Digest(manifest.evidenceSha256)
    || typeof manifest.storagePath !== "string"
    || typeof manifest.fileName !== "string"
    || !Number.isSafeInteger(manifest.fileSize)
    || typeof manifest.stagedAt !== "string"
    || !Number.isFinite(Date.parse(manifest.stagedAt))
  ) {
    return null
  }
  return manifest as PasqManifest
}

async function loadApplication(tenantId: string, id: string) {
  return prisma.loanApplication.findUnique({
    where: { id, tenantId },
    include: {
      client: {
        select: {
          id: true,
          updatedAt: true,
          firstName: true,
          lastName: true,
          idNumber: true,
          addressLine1: true,
            phone: true,
          city: true,
          suburb: true,
          province: true,
          postalCode: true,
        },
      },
      product: {
        select: {
          id: true,
          productType: true,
          interestRatePm: true,
          interestModel: true,
          initiationFeeModel: true,
          initiationFeePct: true,
          initiationFeeMax: true,
          monthlyServiceFee: true,
        },
      },
    },
  })
}

type PasqApplication = NonNullable<Awaited<ReturnType<typeof loadApplication>>>

async function creditLifeOfferIsCurrentlyAvailable(
  tenantId: string,
  application: PasqApplication,
): Promise<boolean> {
  // A no-offer application stays available exactly while no offer exists. If a
  // product were configured after submission, the recorded "no cover offered"
  // would no longer be true and the application must go back to draft.
  if (application.creditLifeDisclosureVersion === CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION) {
    const nowConfigured = await prisma.insuranceProduct.findFirst(
      creditLifeOfferFindFirstArgs(tenantId),
    )
    return nowConfigured === null
  }
  if (
    !application.creditLifeProductId
    || !application.creditLifeProductName
    || !application.creditLifeInsurerId
    || !application.creditLifeInsurerName
  ) {
    return false
  }
  const product = await prisma.insuranceProduct.findFirst({
    where: {
      id: application.creditLifeProductId,
      tenantId,
      type: "CREDIT_LIFE",
      active: true,
      name: application.creditLifeProductName,
      insurerId: application.creditLifeInsurerId,
      insurer: {
        is: {
          id: application.creditLifeInsurerId,
          tenantId,
          active: true,
          name: application.creditLifeInsurerName,
        },
      },
    },
    select: { id: true },
  })
  return product?.id === application.creditLifeProductId
}

function buildEvidence(application: PasqApplication, generatedAt: Date) {
  const creditLife = verifyStoredCreditLifeDisclosure(application, {
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
  })
  if (!creditLife.ok) return { ok: false as const, kind: "credit_life" as const, reason: creditLife.reason }
  const availability = creditLifeAutoBundleDecision(application.appliedAmount)
  if (creditLife.evidence.election === "ACCEPTED" && !availability.eligible) {
    return { ok: false as const, kind: "credit_life" as const, reason: "availability_changed" as const }
  }
  // The quotation must be priced on the terms this application was APPROVED on,
  // not on the product row as it stands now. Minting happens at the signing
  // ceremony, so an ordinary product edit in the window between approval and
  // ceremony would otherwise quote the consumer a price their own approval then
  // rejects. Callers reach here only once status is APPROVED, so the frozen
  // terms always exist; their absence means a corrupt snapshot, not a legitimate
  // pre-approval mint, and must fail loudly rather than fall back to live pricing.
  const frozenTerms = frozenApprovedTerms(application.affordabilityResult)
  if (!frozenTerms.ok) {
    return {
      ok: false as const,
      // Distinguished from the credit-life reasons above: this is an approval
      // evidence failure, and the operator remedy is different.
      kind: "approval_terms" as const,
      approvalTerms: frozenTerms.reason,
    }
  }
  const frozen = frozenTerms.terms
  const calculation = calculateLoanFromDecisionInputs(frozen, generatedAt)
  const calculator = createAffordabilityCalculatorEvidence(calculation, generatedAt)
  return {
    ok: true as const,
    calculation,
    // Surfaced so the rendered quotation states the SAME terms the schedule was
    // priced on. The credit agreement already renders from the approval snapshot;
    // a PASQ rendering live product values would state one rate over a schedule
    // computed at another, in the very packet the consumer signs.
    approvedTerms: frozen,
    evidence: createPasqEvidence({
      tenantId: application.tenantId,
      applicationId: application.id,
      clientId: application.clientId,
      productId: application.productId,
      termDays: application.appliedTermDays,
      generatedAt,
      calculator,
      creditLife: {
        election: creditLife.evidence.election,
        productId: creditLife.evidence.productId,
        productName: creditLife.evidence.productName,
        insurerId: creditLife.evidence.insurerId,
        insurerName: creditLife.evidence.insurerName,
        monthlyPremiumCents: creditLife.evidence.monthlyPremiumCents,
        disclosureVersion: creditLife.evidence.version,
        disclosureSha256: creditLife.evidence.disclosureSha256,
      },
    }),
  }
}

// A no-offer application has no credit-life product or insurer to join to.
// INNER JOINing on its NULL identity columns would eliminate the row entirely
// and read as "the application changed", blocking PASQ generation forever. A
// LEFT JOIN is not an option either: Postgres rejects FOR UPDATE on the
// nullable side of an outer join, so the joins and their lock targets are
// omitted together.
/**
 * An unusable approval snapshot is an APPROVAL-evidence failure on EVERY path
 * that prices a quotation -- minting and revalidating an existing one alike.
 * Reported under either the credit-life message or the "existing PASQ is
 * incomplete" message, it sends the operator to a remedy that cannot fix it.
 */
function approvalTermsErrorResponse(reason: "missing" | "changed") {
  return NextResponse.json({
    error: reason === "missing"
      ? "The approval affordability snapshot this quotation must be priced from is missing. Return the application to review and approve it again."
      : "The approval affordability snapshot failed its integrity check and cannot be used to price a quotation. Escalate to compliance before retrying.",
    affordabilitySnapshot: reason,
  }, { status: 409 })
}

function creditLifeLockFragments(creditLifeProductId: string | null) {
  if (creditLifeProductId === null) {
    return {
      creditLifeColumns: Prisma.sql`
        NULL::TEXT AS "creditLifeProductId",
        NULL::TEXT AS "creditLifeProductName",
        NULL::TEXT AS "creditLifeInsurerId",
        NULL::TEXT AS "creditLifeInsurerName"`,
      creditLifeJoins: Prisma.empty,
      lockTargets: Prisma.sql`FOR UPDATE OF application, client, product`,
    }
  }
  return {
    creditLifeColumns: Prisma.sql`
      credit_life_product."id" AS "creditLifeProductId",
      credit_life_product."name" AS "creditLifeProductName",
      credit_life_insurer."id" AS "creditLifeInsurerId",
      credit_life_insurer."name" AS "creditLifeInsurerName"`,
    creditLifeJoins: Prisma.sql`
      JOIN "InsuranceProduct" AS credit_life_product
        ON credit_life_product."id" = application."creditLifeProductId"
        AND credit_life_product."tenantId" = application."tenantId"
        AND credit_life_product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
        AND credit_life_product."active" = TRUE
      JOIN "Insurer" AS credit_life_insurer
        ON credit_life_insurer."id" = application."creditLifeInsurerId"
        AND credit_life_insurer."id" = credit_life_product."insurerId"
        AND credit_life_insurer."tenantId" = application."tenantId"
        AND credit_life_insurer."active" = TRUE`,
    lockTargets: Prisma.sql`FOR UPDATE OF application, client, product, credit_life_product, credit_life_insurer`,
  }
}

async function applicationStillMatches(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  tenantId: string,
  application: PasqApplication,
  providerIdentity: StatutoryProviderIdentity,
): Promise<boolean> {
  if (!await lockCurrentStatutoryProviderIdentity(
    tx,
    tenantId,
    providerIdentity,
  )) {
    return false
  }
  const { creditLifeColumns, creditLifeJoins, lockTargets } =
    creditLifeLockFragments(application.creditLifeProductId)
  const rows = await tx.$queryRaw<Array<{
    applicationUpdatedAt: Date
    clientUpdatedAt: Date
    status: string
    pasqDocumentId: string | null
    productType: string
    interestRatePm: number
    interestModel: string
    initiationFeeModel: string
    initiationFeePct: number
    initiationFeeMax: number
    monthlyServiceFee: number
    creditLifeProductId: string | null
    creditLifeProductName: string | null
    creditLifeInsurerId: string | null
    creditLifeInsurerName: string | null
  }>>(Prisma.sql`
    SELECT
      application."updatedAt" AS "applicationUpdatedAt",
      client."updatedAt" AS "clientUpdatedAt",
      application."status"::TEXT AS "status",
      application."pasqDocumentId" AS "pasqDocumentId",
      product."productType"::TEXT AS "productType",
      product."interestRatePm" AS "interestRatePm",
      product."interestModel"::TEXT AS "interestModel",
      product."initiationFeeModel"::TEXT AS "initiationFeeModel",
      product."initiationFeePct" AS "initiationFeePct",
      product."initiationFeeMax" AS "initiationFeeMax",
      product."monthlyServiceFee" AS "monthlyServiceFee",
      ${creditLifeColumns}
    FROM "LoanApplication" AS application
    JOIN "Client" AS client ON client."id" = application."clientId"
    JOIN "LoanProduct" AS product ON product."id" = application."productId"
    ${creditLifeJoins}
    WHERE application."id" = ${application.id}
      AND application."tenantId" = ${tenantId}
    ${lockTargets}
  `)
  const row = rows[0]
  return !!row
    && row.status === "APPROVED"
    && row.pasqDocumentId === null
    && row.applicationUpdatedAt.toISOString() === application.updatedAt.toISOString()
    && row.clientUpdatedAt.toISOString() === application.client.updatedAt.toISOString()
    && row.productType === application.product.productType
    && row.interestRatePm === application.product.interestRatePm
    && row.interestModel === application.product.interestModel
    && row.initiationFeeModel === application.product.initiationFeeModel
    && row.initiationFeePct === application.product.initiationFeePct
    && row.initiationFeeMax === application.product.initiationFeeMax
    && row.monthlyServiceFee === application.product.monthlyServiceFee
    && row.creditLifeProductId === application.creditLifeProductId
    && row.creditLifeProductName === application.creditLifeProductName
    && row.creditLifeInsurerId === application.creditLifeInsurerId
    && row.creditLifeInsurerName === application.creditLifeInsurerName
}

async function failStaging(args: {
  tenantId: string
  applicationId: string
  stagingId: string
  idempotencyKey: string
  manifest: PasqManifest
  userId: string
  userEmail: string
  reason: string
  expectedLifecycle?: "STAGING" | "RECONCILING"
}): Promise<boolean> {
  try {
    await deleteManagedFileStrict(args.manifest.storagePath)
  } catch {
    return false
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const failedAt = new Date()
      const failed = await tx.complianceRecord.updateMany({
        where: {
          id: args.stagingId,
          tenantId: args.tenantId,
          idempotencyKey: args.idempotencyKey,
          status: "PENDING",
          data: { path: ["lifecycle"], equals: args.expectedLifecycle ?? "STAGING" },
        },
        data: {
          idempotencyKey: null,
          status: "COMPLETED",
          completedAt: failedAt,
          data: {
            ...args.manifest,
            lifecycle: "FAILED",
            failedAt: failedAt.toISOString(),
            failureReason: args.reason,
          } as Prisma.InputJsonValue,
        },
      })
      if (failed.count !== 1) return false
      await tx.auditLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.userId,
          userEmail: args.userEmail,
          action: AuditAction.PASQ_ARTIFACT_STAGING_FAILED,
          entity: "LoanApplication",
          entityId: args.applicationId,
          oldValue: {
            stagingId: args.stagingId,
            lifecycle: args.expectedLifecycle ?? "STAGING",
            documentSha256: args.manifest.documentSha256,
          },
          newValue: { lifecycle: "FAILED", reason: args.reason, bytesDeleted: true },
        },
      })
      return true
    })
  } catch {
    return false
  }
}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        pasqGeneratedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
      },
    })
    if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (
      !application.pasqGeneratedAt
      || !application.pasqDocumentId
      || !isSha256Digest(application.pasqDocumentSha256)
    ) {
      return NextResponse.json({ error: "PASQ has not been generated yet" }, { status: 404 })
    }
    const document = await prisma.clientDocument.findFirst({
      where: {
        id: application.pasqDocumentId,
        tenantId: tenant.id,
        clientId: application.clientId,
        docType: "FORM_20_PRE_AGREEMENT",
        deletedAt: null,
        contentSha256: application.pasqDocumentSha256,
        storagePath: { not: null },
      },
    })
    if (!document?.storagePath) {
      return NextResponse.json({ error: "The application-bound PASQ document is missing." }, { status: 422 })
    }
    let bytes: Buffer
    try {
      bytes = await readFile(document.storagePath)
    } catch {
      return NextResponse.json({ error: "The application-bound PASQ bytes are unavailable." }, { status: 422 })
    }
    if (!documentBytesMatchSha256(bytes, application.pasqDocumentSha256)) {
      return NextResponse.json({ error: "The PASQ bytes failed their integrity check." }, { status: 422 })
    }
    await prisma.documentAccessLog.create({
      data: {
        documentId: document.id,
        accessorType: access.type,
        accessorId: access.type === "staff" ? access.user.id : access.clientId,
        action: "view",
        ipAddress: req.headers.get("x-forwarded-for") ?? null,
        userAgent: req.headers.get("user-agent") ?? null,
      },
    })
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="pasq-${id}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Document-SHA256": application.pasqDocumentSha256,
      },
    })
  })
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const application = await loadApplication(tenant.id, id)
    if (!application) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    // NCA s.92(1) requires the quotation before the agreement is ENTERED INTO,
    // not before the credit decision. The PASQ is therefore minted at the start
    // of the signing ceremony, against an APPROVED application, so the quote is
    // inside its s.92(3) binding window when the consumer signs. It must be
    // issued before the agreement PDF exists — agreement generation enforces
    // `agreementGeneratedAt >= pasqGeneratedAt` and binds to this document.
    if (application.status !== "APPROVED") {
      return NextResponse.json({
        error: "PASQ generation requires an approved application; it is issued at the start of the signing ceremony.",
      }, { status: 409 })
    }
    if (application.agreementGeneratedAt) {
      return NextResponse.json({
        error: "The agreement has already been generated for this application. Return it to review to start a new quotation.",
      }, { status: 409 })
    }
    // The quotation must state the terms that were APPROVED. Its evidence is
    // built from appliedAmount/appliedTermDays because the database binds it to
    // those columns, and approval requires the two pairs to be equal — so if
    // they have drifted, the quotation would understate or overstate what was
    // granted. Refuse rather than quote the wrong number.
    if (
      application.approvedAmount !== application.appliedAmount
      || application.approvedTermDays !== application.appliedTermDays
    ) {
      return NextResponse.json({
        error: "The approved amount and term no longer match the applied amount and term; return the application to review before issuing a quotation.",
        pricingEvidence: "approved_terms_drifted",
      }, { status: 409 })
    }
    if (!await creditLifeOfferIsCurrentlyAvailable(tenant.id, application)) {
      return NextResponse.json({
        error: "The credit-life offer captured by the client is no longer active or no longer matches the configured product and insurer. Return the application to draft and capture a current election.",
        creditLifeEvidence: "availability_changed",
      }, { status: 409 })
    }
    // Approval enforces the lenient "origination" KYC grade; generating and
    // signing the agreement enforce the strict "payout" one. Minting the
    // quotation without the strict check issues a real, binding s.92(3)
    // quotation that no agreement can ever follow — and a PASQ carries a
    // consumer signature block, so what the client signs and returns is a
    // quotation they believe is their credit agreement. That happened twice on
    // 2026-08-04. Refuse at the grade the very next step demands.
    const kycSubject = await prisma.client.findFirst({
      where: { id: application.clientId, tenantId: tenant.id },
      select: {
        id: true,
        idNumber: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        kycStatus: true,
        kycVerifiedAt: true,
        kycVerifiedById: true,
        kycVerificationMethod: true,
        kycManualRejectionActive: true,
      },
    })
    if (!kycSubject) {
      return NextResponse.json({
        error: "The client record for this application could not be read; the quotation cannot be issued.",
        compositeKyc: "client_unavailable",
      }, { status: 422 })
    }
    // Mirrors the payout grade in lib/affordability/current-approval.ts: the
    // cached projection must agree AND the composite evidence must be intact.
    //
    // Deliberately placed ahead of the re-serve branch too, not only the mint:
    // if identity evidence regresses after a valid mint, handing the quotation
    // out again is the wrong default for a lender, and the agreement can no
    // longer be generated anyway. (GET /pasq still serves the stored bytes to
    // an owner or staff — a separate, pre-existing surface this does not
    // change.)
    const quotationKyc = await readCompositeKycState(
      prisma as unknown as CompositeKycReader,
      {
        tenantId: tenant.id,
        clientId: application.clientId,
        subject: kycSubject,
        existing: kycSubject,
        preserveVerifiedProvenance: true,
      },
    )
    if (kycSubject.kycStatus !== "VERIFIED" || !quotationKyc.ok) {
      // A manual rejection forces ok=false whatever the documents and
      // biometrics say, and ONLY an authorised KYC decision clears it. Offering
      // the generic remedy here would send staff to capture a selfie that
      // cannot possibly unblock them — the same misdirection
      // lib/kyc/kyc-blockers.ts already avoids by returning this blocker alone.
      const manualRejectionActive = quotationKyc.manualRejectionActive === true
      return NextResponse.json({
        error: manualRejectionActive
          ? "This client's KYC has been manually rejected. An authorised KYC decision must resolve the rejection before a quotation can be issued — re-capturing documents will not clear it."
          : "Issuing the quotation requires all four core KYC documents plus a current valid biometric, an exact reasoned senior exception, or a recorded in-person verification — the same evidence the credit agreement requires. Complete identity verification before issuing the quotation.",
        compositeKyc: manualRejectionActive
          ? "manual_rejection_active"
          : "payout_grade_required",
        manualRejectionActive,
        // Suppressed under a manual rejection: a stale biometric reason listed
        // beside it reads as the thing to go and fix.
        biometricEvidence: manualRejectionActive ? null : quotationKyc.biometricEvidence,
        missingDocs: manualRejectionActive ? [] : quotationKyc.missingCoreDocuments,
      }, { status: 422 })
    }
    if (application.pasqDocumentId) {
      const evidence = application.pasqEvidence
      const current = application.pasqGeneratedAt
        ? buildEvidence(application, application.pasqGeneratedAt)
        : null
      // Before judging the stored PASQ, say so if the approval it must be
      // reconciled against is itself unusable -- otherwise this reports a PASQ
      // defect and never names the actual remedy.
      if (current && !current.ok && current.kind === "approval_terms") {
        return approvalTermsErrorResponse(current.approvalTerms)
      }
      if (
        application.pasqVersion === PASQ_VERSION
        && application.pasqGeneratedAt
        && isSha256Digest(application.pasqDocumentSha256)
        && pasqEvidenceIsIntact(evidence)
        && evidence.evidenceSha256 === application.pasqEvidenceSha256
        && current?.ok
        && current.evidence.evidenceSha256 === evidence.evidenceSha256
      ) {
        const document = await prisma.clientDocument.findFirst({
          where: {
            id: application.pasqDocumentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "FORM_20_PRE_AGREEMENT",
            deletedAt: null,
            contentSha256: application.pasqDocumentSha256,
            storagePath: { not: null },
          },
        })
        if (!document?.storagePath) {
          return NextResponse.json({
            error: "The existing application-bound PASQ document is missing.",
          }, { status: 422 })
        }
        let bytes: Buffer
        try {
          bytes = await readFile(document.storagePath)
        } catch {
          return NextResponse.json({
            error: "The existing application-bound PASQ bytes are unavailable.",
          }, { status: 422 })
        }
        if (!documentBytesMatchSha256(bytes, application.pasqDocumentSha256)) {
          return NextResponse.json({
            error: "The existing PASQ bytes failed their integrity check.",
          }, { status: 422 })
        }
        return NextResponse.json({
          id: application.pasqDocumentId,
          documentSha256: application.pasqDocumentSha256,
          evidenceSha256: evidence.evidenceSha256,
          generatedAt: application.pasqGeneratedAt,
          existing: true,
        })
      }
      return NextResponse.json({
        error: "The existing PASQ is incomplete and requires compliance reconciliation.",
      }, { status: 409 })
    }

    const idempotencyKey = artifactKey(tenant.id, id)
    const outstandingArtifact = await prisma.complianceRecord.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        tenantId: true,
        status: true,
        dueDate: true,
        data: true,
      },
    })
    if (outstandingArtifact) {
      const manifest = readPasqManifest(outstandingArtifact.data)
      if (
        outstandingArtifact.tenantId !== tenant.id
        || outstandingArtifact.status !== "PENDING"
        || !manifest
        || manifest.applicationId !== id
        || (manifest.lifecycle !== "STAGING" && manifest.lifecycle !== "RECONCILING")
      ) {
        return NextResponse.json({
          error: "PASQ artifact reconciliation is required before generation can continue.",
          pasqIntegrity: "staging_reconciliation_required",
        }, { status: 503 })
      }

      let reconcilingManifest = manifest
      let recoveryReason = "Resumed cleanup of an interrupted PASQ artifact reconciliation before retry."
      if (manifest.lifecycle === "STAGING") {
        const leaseActive = outstandingArtifact.dueDate instanceof Date
          && outstandingArtifact.dueDate.getTime() > Date.now()
        if (leaseActive) {
          return NextResponse.json({
            error: "PASQ generation is already in progress.",
            pasqIntegrity: "staging_in_progress",
          }, { status: 409 })
        }

        reconcilingManifest = { ...manifest, lifecycle: "RECONCILING" }
        recoveryReason = "Recovered an expired PASQ artifact staging lease before retry."
        const claimed = await prisma.$transaction(async (tx) => {
          const updated = await tx.complianceRecord.updateMany({
            where: {
              id: outstandingArtifact.id,
              tenantId: tenant.id,
              idempotencyKey,
              status: "PENDING",
              dueDate: { lte: new Date() },
              data: { path: ["lifecycle"], equals: "STAGING" },
            },
            data: {
              data: reconcilingManifest as unknown as Prisma.InputJsonValue,
            },
          })
          if (updated.count !== 1) return false
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.PASQ_ARTIFACT_STAGING_RECOVERY_STARTED,
              entity: "LoanApplication",
              entityId: id,
              oldValue: {
                stagingId: outstandingArtifact.id,
                lifecycle: "STAGING",
                documentId: manifest.documentId,
                documentSha256: manifest.documentSha256,
              },
              newValue: { lifecycle: "RECONCILING", leaseExpired: true },
            },
          })
          return true
        })
        if (!claimed) {
          return NextResponse.json({
            error: "The PASQ artifact changed while stale recovery was starting; refresh before retry.",
            pasqIntegrity: "staging_reconciliation_required",
          }, { status: 503 })
        }
      }

      const recovered = await failStaging({
        tenantId: tenant.id,
        applicationId: id,
        stagingId: outstandingArtifact.id,
        idempotencyKey,
        manifest: reconcilingManifest,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: recoveryReason,
        expectedLifecycle: "RECONCILING",
      })
      if (!recovered) {
        return NextResponse.json({
          error: "The expired PASQ artifact could not be reconciled safely.",
          pasqIntegrity: "staging_reconciliation_required",
        }, { status: 503 })
      }
    }

    const generatedAt = new Date()
    const current = buildEvidence(application, generatedAt)
    if (!current.ok) {
      // An unusable approval snapshot is NOT a credit-life defect. Reporting it
      // under the credit-life message sent the operator to re-capture a cover
      // election, which cannot fix a missing or tampered approval.
      if (current.kind === "approval_terms") {
        return approvalTermsErrorResponse(current.approvalTerms)
      }
      return NextResponse.json({
        error: "PASQ generation requires an intact, currently available credit-life election and exact-premium disclosure.",
        creditLifeEvidence: current.reason,
      }, { status: current.reason === "availability_changed" ? 409 : 422 })
    }
    const tenantRecord = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      include: { config: true },
    })
    if (!tenantRecord) throw new Error("Tenant not found")
    const providerIdentity = statutoryProviderIdentityFromTenant(tenantRecord)
    if (!providerIdentity) {
      return NextResponse.json({
        error: "PASQ generation requires configured statutory provider identity.",
        pasqIntegrity: "provider_identity_missing",
      }, { status: 503 })
    }
    const elected = current.evidence.creditLife.election === "ACCEPTED"
    let quoteValidUntilDate: string
    try {
      quoteValidUntilDate = await quotationValidUntilDateFromDatabase(
        prisma,
        generatedAt,
      )
    } catch {
      return NextResponse.json({
        error: "PASQ generation requires the South African business-day calendar.",
        pasqIntegrity: "business_calendar_unavailable",
      }, { status: 503 })
    }
    const pdf = await generateCreditAgreementPdf({
      variant: "pasq",
      logo: await getLenderLogo(tenant.id),
      // Same marker on every page of both documents in the packet, so a page
      // substituted into a PRINTED return is detectable. Derived from the PASQ
      // evidence digest, which exists before this render — a document cannot
      // carry its own digest.
      ceremonyMarker: current.ok ? ceremonyMarkerFor(current.evidence.evidenceSha256) : undefined,
      lender: {
        legalName: providerIdentity.tenantName,
        ncrNumber: providerIdentity.statutoryNcrNumber,
      },
      client: {
        firstName: application.client.firstName,
        lastName: application.client.lastName,
        idNumber: application.client.idNumber,
        addressLine1: application.client.addressLine1 ?? undefined,
        city: application.client.city ?? undefined,
        suburb: application.client.suburb ?? undefined,
        province: application.client.province ?? undefined,
        postalCode: application.client.postalCode ?? undefined,
          phone: application.client.phone ?? undefined,
      },
      application: {
        reference: application.reference,
        agreementType: application.agreementType ?? undefined,
        appliedTermDays: application.appliedTermDays,
      },
      calc: current.calculation,
      product: {
        interestRatePm: current.approvedTerms.interestRatePm,
        interestModel: current.approvedTerms.interestModel,
        monthlyServiceFee: current.approvedTerms.monthlyServiceFeeCents,
      },
      startDate: generatedAt,
      maturityDate: current.calculation.schedule.at(-1)?.dueDate ?? generatedAt,
      quotePresentedAt: generatedAt,
      quoteValidUntilDate,
      willAutoBundleCl: elected,
      // Omitted entirely when no cover was offered. creditAgreement.ts renders
      // its "Offered Credit Life Product/Insurer/Premium" rows whenever this
      // key is present, so passing blanks would state on an NCA document that
      // cover was offered and declined when none was ever available.
      creditLife:
        current.evidence.creditLife.productName !== null
        && current.evidence.creditLife.insurerName !== null
          ? {
              elected,
              productName: current.evidence.creditLife.productName,
              insurerName: current.evidence.creditLife.insurerName,
              monthlyPremiumCents: current.evidence.creditLife.monthlyPremiumCents,
              premiumPeriods: current.evidence.creditLife.premiumPeriods,
              totalPremiumCents: current.evidence.creditLife.totalPremiumCents,
              billing: current.evidence.billing,
            }
          : undefined,
      initiationFeePayment: application.initiationFeePayment,
    })
    const documentSha256 = sha256DocumentBytes(pdf)
    const documentId = randomUUID()
    const storageKey = `pasq-${documentId}`
    const storagePath = managedStoragePath(storageKey, "application/pdf")
    const fileName = `pasq-${id}.pdf`
    const stagedAt = new Date()
    const manifest: PasqManifest = {
      kind: PASQ_ARTIFACT_KIND,
      lifecycle: "STAGING",
      applicationId: id,
      documentId,
      documentSha256,
      evidenceSha256: current.evidence.evidenceSha256,
      storagePath,
      fileName,
      fileSize: pdf.length,
      stagedAt: stagedAt.toISOString(),
    }

    let stagingId: string
    try {
      stagingId = await prisma.$transaction(async (tx) => {
        if (!await applicationStillMatches(
          tx,
          tenant.id,
          application,
          providerIdentity,
        )) {
          throw new Error("PASQ evidence changed before staging")
        }
        const staged = await tx.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            type: "AGREEMENT_ARTIFACT",
            referenceId: id,
            idempotencyKey,
            status: "PENDING",
            dueDate: new Date(stagedAt.getTime() + STAGING_LEASE_MS),
            data: manifest as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.PASQ_ARTIFACT_STAGED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              stagingId: staged.id,
              documentId,
              documentSha256,
              evidenceSha256: current.evidence.evidenceSha256,
              expectedFileSize: pdf.length,
            },
          },
        })
        return staged.id
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json({ error: "PASQ generation is already in progress." }, { status: 409 })
      }
      return NextResponse.json({ error: "PASQ evidence changed before generation; refresh and try again." }, { status: 409 })
    }

    const markFailed = (reason: string) => failStaging({
      tenantId: tenant.id,
      applicationId: id,
      stagingId,
      idempotencyKey,
      manifest,
      userId: guard.user.id,
      userEmail: guard.user.email,
      reason,
    })

    try {
      const stored = await saveFileToManagedPath(pdf, "application/pdf", storageKey)
      if (stored.storagePath !== storagePath || stored.fileSize !== pdf.length) {
        throw new Error("Managed storage returned unexpected PASQ metadata")
      }
      const persisted = await readFile(storagePath)
      if (!documentBytesMatchSha256(persisted, documentSha256)) {
        throw new Error("Managed PASQ bytes did not match the staged digest")
      }
    } catch (error) {
      const cleaned = await markFailed(`Managed PASQ storage failed: ${error instanceof Error ? error.message : String(error)}`)
      return NextResponse.json({
        error: cleaned
          ? "The PASQ could not be written and verified in managed storage."
          : "The failed PASQ artifact requires storage reconciliation.",
      }, { status: cleaned ? 500 : 503 })
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        if (!await applicationStillMatches(
          tx,
          tenant.id,
          application,
          providerIdentity,
        )) {
          throw new Error("PASQ evidence changed before finalization")
        }
        const document = await tx.clientDocument.create({
          data: {
            id: documentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "FORM_20_PRE_AGREEMENT",
            fileUrl: `/api/applications/${id}/pasq`,
            fileName,
            storagePath,
            fileSize: pdf.length,
            mimeType: "application/pdf",
            contentSha256: documentSha256,
            uploadedByType: "staff",
            uploadedById: guard.user.id,
            extractionStatus: "skipped",
            verified: false,
          },
        })
        const changed = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            updatedAt: application.updatedAt,
            pasqDocumentId: null,
            agreementGeneratedAt: null,
          },
          data: {
            pasqVersion: PASQ_VERSION,
            pasqGeneratedAt: generatedAt,
            pasqDocumentId: documentId,
            pasqDocumentSha256: documentSha256,
            pasqEvidence: current.evidence as unknown as Prisma.InputJsonValue,
            pasqEvidenceSha256: current.evidence.evidenceSha256,
            pasqAcknowledgedAt: null,
            pasqAcknowledgedBy: null,
            pasqAcknowledgedSha256: null,
            // Approval no longer stamps this — it runs before any quotation
            // exists — and neither does issue. The digest every downstream gate
            // pins is written at ACKNOWLEDGEMENT, so it can only ever name a
            // document the consumer actually accepted. Setting it here would
            // make it satisfiable in a state where nothing was acknowledged,
            // which is exactly what the database CHECK now refuses.
            approvedPasqDocumentSha256: null,
          },
        })
        if (changed.count !== 1) throw new Error("PASQ application changed")
        // §3 M: superseded generations of this application's quotation must
        // not stay visible beside the bound one — three indistinguishable
        // PASQs on one client is exactly the state a regulator asks about.
        // The legacy application-bound filename identifies prior generations.
        await tx.clientDocument.updateMany({
          where: {
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "FORM_20_PRE_AGREEMENT",
            fileName,
            deletedAt: null,
            id: { not: documentId },
          },
          data: {
            deletedAt: generatedAt,
            deletedByType: "staff",
            deletedById: guard.user.id,
          },
        })
        const completedAt = new Date()
        const completed = await tx.complianceRecord.updateMany({
          where: {
            id: stagingId,
            tenantId: tenant.id,
            idempotencyKey,
            status: "PENDING",
            data: { path: ["lifecycle"], equals: "STAGING" },
          },
          data: {
            idempotencyKey: null,
            status: "COMPLETED",
            completedAt,
            data: {
              ...manifest,
              lifecycle: "COMPLETED",
              completedAt: completedAt.toISOString(),
            } as Prisma.InputJsonValue,
          },
        })
        if (completed.count !== 1) throw new Error("PASQ staging lease changed")
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.PASQ_GENERATED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              documentId,
              documentSha256,
              version: PASQ_VERSION,
              evidenceSha256: current.evidence.evidenceSha256,
              totalCostOfCreditCents: current.evidence.totalCostOfCreditCents,
              creditLifeElection: current.evidence.creditLife.election,
              creditLifeTotalPremiumCents: current.evidence.creditLife.totalPremiumCents,
              stagingId,
            },
          },
        })
        return document
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return NextResponse.json({
        id: created.id,
        documentSha256,
        evidenceSha256: current.evidence.evidenceSha256,
        generatedAt,
      })
    } catch (error) {
      const committed = await prisma.loanApplication.findFirst({
        where: { id, tenantId: tenant.id, pasqDocumentId: documentId, pasqDocumentSha256: documentSha256 },
        select: { pasqDocumentId: true },
      })
      if (committed) {
        return NextResponse.json({
          id: documentId,
          documentSha256,
          evidenceSha256: current.evidence.evidenceSha256,
          generatedAt,
          reconciled: true,
        })
      }
      const cleaned = await markFailed(`PASQ finalization failed: ${error instanceof Error ? error.message : String(error)}`)
      return NextResponse.json({
        error: cleaned
          ? "The application changed before the PASQ could be recorded."
          : "The staged PASQ requires reconciliation before retry.",
      }, { status: cleaned ? 409 : 503 })
    }
  })
}
