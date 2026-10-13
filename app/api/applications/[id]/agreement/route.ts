import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { randomUUID } from "node:crypto"
import { requireOwnerOrStaff, requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { generateCreditAgreementPdfWithAnchors } from "@/lib/pdf/creditAgreement"
import type { AgreementSignatureAnchors } from "@/lib/pdf/creditAgreement"
import { readAgreementSignatureAnchors } from "@/lib/pdf/executed-agreement"
import { buildAgreementRenderInput, ceremonyMarkerFor } from "@/lib/pdf/agreement-render-input"
import {
  deleteManagedFileStrict,
  managedStoragePath,
  readFile,
  saveFileToManagedPath,
} from "@/lib/storage"
import { withTenantContext } from "@/lib/tenant"
import { bureauStalenessCutoff } from "@/lib/compliance/bureau"
import {
  acceptedPasqCalculatorFingerprint,
  createAffordabilityContractEvidence,
  loanCalculationFromEvidence,
  readAffordabilitySnapshotStore,
  withAffordabilityContract,
} from "@/lib/affordability/snapshot"
import {
  verifyCurrentAffordabilityApproval,
  verifyLockedCurrentAffordabilityApproval,
} from "@/lib/affordability/current-approval"
import { AuditAction } from "@/lib/audit"
import { Prisma } from "@prisma/client"
import {
  documentBytesMatchSha256,
  isSha256Digest,
  sha256DocumentBytes,
} from "@/lib/documents/content-integrity"
import { creditLifeAutoBundleDecision } from "@/lib/insurance/credit-life-containment"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { verifyStoredPasqBinding } from "@/lib/compliance/pasq"
import { verifyPasqDocumentArtifact } from "@/lib/compliance/pasq-document.server"
import {
  lockCurrentStatutoryProviderIdentity,
  statutoryProviderIdentityFromTenant,
} from "@/lib/compliance/statutory-provider-identity.server"
import { quotationValidUntilDateFromDatabase } from "@/lib/compliance/sa-business-calendar.server"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

const AGREEMENT_ARTIFACT_KIND = "CREDIT_AGREEMENT_ARTIFACT"
const AGREEMENT_STAGING_LEASE_MS = 15 * 60 * 1000

type AgreementArtifactManifest = {
  kind: typeof AGREEMENT_ARTIFACT_KIND
  lifecycle: "STAGING" | "RECONCILING" | "COMPLETED" | "FAILED"
  applicationId: string
  documentId: string
  documentSha256: string
  storagePath: string
  fileName: string
  fileSize: number
  stagedAt: string
  creditLifeAutoBundleEligible?: boolean
  creditLifeElection?: "ACCEPTED" | "DECLINED"
  // Null (never undefined) when no cover was offered: this manifest is stored
  // as JSON and undefined-valued keys are dropped on serialisation, which the
  // disbursement re-read compares with strict !== against null.
  creditLifeProductId?: string | null
  creditLifeProductName?: string | null
  creditLifeInsurerId?: string | null
  creditLifeInsurerName?: string | null
  creditLifeMonthlyPremiumCents?: number
  creditLifeDisclosureVersion?: string
  creditLifeDisclosureSha256?: string
  pasqVersion?: string
  pasqDocumentId?: string
  pasqDocumentSha256?: string
  pasqEvidenceSha256?: string
  pasqTotalCostOfCreditCents?: number
  /**
   * Where this render put the blank signature rules, so countersignature can
   * stamp the real signatures onto THESE bytes instead of re-rendering the
   * document from evidence. The block flows after a variable-length repayment
   * schedule, so its position is not a constant and cannot be recomputed
   * without reproducing the whole render.
   *
   * Explicit null, never undefined — see the credit-life note above: this is
   * stored as JSON and undefined-valued keys are dropped on serialisation.
   * Agreements generated before this existed simply have no key, which the
   * countersign route treats the same as null (append an execution page).
   */
  signatureAnchors?: AgreementSignatureAnchors | null
  failureReason?: string
  failedAt?: string
  completedAt?: string
}

function agreementArtifactKey(tenantId: string, applicationId: string): string {
  return `agreement-artifact:${tenantId}:${applicationId}`
}

type CreditLifeOfferBinding = {
  productId: string
  productName: string
  insurerId: string
  insurerName: string
}

async function currentCreditLifeOfferIsActive(
  tenantId: string,
  binding: CreditLifeOfferBinding,
): Promise<boolean> {
  const product = await prisma.insuranceProduct.findFirst({
    where: {
      id: binding.productId,
      tenantId,
      name: binding.productName,
      type: "CREDIT_LIFE",
      active: true,
      insurerId: binding.insurerId,
      insurer: {
        is: {
          id: binding.insurerId,
          tenantId,
          name: binding.insurerName,
          active: true,
        },
      },
    },
    select: { id: true },
  })
  return product?.id === binding.productId
}

async function lockCurrentCreditLifeOffer(
  tx: {
    $queryRaw: (
      query: Prisma.Sql,
    ) => Promise<Array<{ id: string }>>
  },
  tenantId: string,
  binding: CreditLifeOfferBinding,
): Promise<boolean> {
  const rows = await tx.$queryRaw(Prisma.sql`
    SELECT product."id"
    FROM "InsuranceProduct" AS product
    JOIN "Insurer" AS insurer
      ON insurer."id" = product."insurerId"
      AND insurer."tenantId" = product."tenantId"
    WHERE product."id" = ${binding.productId}
      AND product."tenantId" = ${tenantId}
      AND product."name" = ${binding.productName}
      AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
      AND product."active" = TRUE
      AND insurer."id" = ${binding.insurerId}
      AND insurer."tenantId" = ${tenantId}
      AND insurer."name" = ${binding.insurerName}
      AND insurer."active" = TRUE
    FOR SHARE OF product, insurer
  `)
  return rows.length === 1 && rows[0].id === binding.productId
}

function readAgreementArtifactManifest(value: Prisma.JsonValue): AgreementArtifactManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (
    data.kind !== AGREEMENT_ARTIFACT_KIND
    || !["STAGING", "RECONCILING", "COMPLETED", "FAILED"].includes(String(data.lifecycle))
    || typeof data.applicationId !== "string"
    || typeof data.documentId !== "string"
    || !isSha256Digest(typeof data.documentSha256 === "string" ? data.documentSha256 : null)
    || typeof data.storagePath !== "string"
    || typeof data.fileName !== "string"
    || typeof data.fileSize !== "number"
    || typeof data.stagedAt !== "string"
    || (
      data.creditLifeAutoBundleEligible !== undefined
      && typeof data.creditLifeAutoBundleEligible !== "boolean"
    )
    || (
      data.creditLifeElection !== undefined
      && data.creditLifeElection !== "ACCEPTED"
      && data.creditLifeElection !== "DECLINED"
    )
    || (data.pasqDocumentSha256 !== undefined
      && !isSha256Digest(typeof data.pasqDocumentSha256 === "string" ? data.pasqDocumentSha256 : null))
    || (data.pasqEvidenceSha256 !== undefined
      && !isSha256Digest(typeof data.pasqEvidenceSha256 === "string" ? data.pasqEvidenceSha256 : null))
    // Present-but-unreadable anchors are rejected here rather than silently
    // ignored: they would otherwise flow to countersignature, which would stamp
    // a signature at a garbage coordinate on an NCA document. Absent (undefined
    // or null) is legitimate — that is every agreement generated before anchors
    // were recorded — and routes to the appended execution page instead.
    || (
      data.signatureAnchors !== undefined
      && data.signatureAnchors !== null
      && readAgreementSignatureAnchors(data.signatureAnchors) === null
    )
  ) return null
  return data as AgreementArtifactManifest
}

async function findCommittedAgreementArtifact(args: {
  tenantId: string
  clientId: string
  applicationId: string
  documentId: string
  documentSha256: string
}) {
  const [document, applicationBinding, generationAudit] = await Promise.all([
    prisma.clientDocument.findFirst({
      where: {
        id: args.documentId,
        tenantId: args.tenantId,
        clientId: args.clientId,
        docType: "CREDIT_AGREEMENT",
        deletedAt: null,
        storagePath: { not: null },
        contentSha256: args.documentSha256,
      },
    }),
    prisma.loanApplication.findFirst({
      where: {
        id: args.applicationId,
        tenantId: args.tenantId,
        clientId: args.clientId,
        agreementDocumentId: args.documentId,
        agreementDocumentSha256: args.documentSha256,
      },
      select: { id: true },
    }),
    prisma.auditLog.findFirst({
      where: {
        tenantId: args.tenantId,
        action: {
          in: [
            AuditAction.AGREEMENT_GENERATED,
            AuditAction.AGREEMENT_INTEGRITY_BACKFILLED,
          ],
        },
        entity: "LoanApplication",
        entityId: args.applicationId,
        AND: [
          { newValue: { path: ["documentId"], equals: args.documentId } },
          { newValue: { path: ["documentSha256"], equals: args.documentSha256 } },
        ],
      },
      select: { id: true },
    }),
  ])
  if (!document?.storagePath || (!applicationBinding && !generationAudit)) return null
  const bytes = await readFile(document.storagePath)
  return documentBytesMatchSha256(bytes, args.documentSha256) ? document : null
}

async function markAgreementStagingFailed(args: {
  tenantId: string
  applicationId: string
  stagingId: string
  idempotencyKey: string
  manifest: AgreementArtifactManifest
  userId: string
  userEmail: string
  reason: string
  expectedLifecycle: "STAGING" | "RECONCILING"
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
          data: { path: ["lifecycle"], equals: args.expectedLifecycle },
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
          action: AuditAction.AGREEMENT_ARTIFACT_STAGING_FAILED,
          entity: "LoanApplication",
          entityId: args.applicationId,
          oldValue: {
            stagingId: args.stagingId,
            lifecycle: args.expectedLifecycle,
            documentId: args.manifest.documentId,
            documentSha256: args.manifest.documentSha256,
          },
          newValue: {
            lifecycle: "FAILED",
            reason: args.reason,
            bytesDeleted: true,
          },
        },
      })
      return true
    })
  } catch {
    // The manifest remains a durable pointer to the expected path/hash. A
    // subsequent retry can reconcile it; never hide the failure as cleanup.
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
        agreementGeneratedAt: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The credit agreement is a consumer NCA document; an entity borrower is refused.
    if (application.clientId === null) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }

    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (!application.agreementGeneratedAt) {
      return NextResponse.json(
        { error: "Agreement has not been generated yet" },
        { status: 404 },
      )
    }
    if (
      !application.agreementDocumentId ||
      !isSha256Digest(application.agreementDocumentSha256)
    ) {
      return NextResponse.json(
        {
          error: "The generated agreement is missing its integrity binding. Run the audited legacy agreement-integrity backfill or reconcile the record before access.",
          agreementIntegrity: "legacy_backfill_required",
        },
        { status: 422 },
      )
    }

    const existingDoc = await prisma.clientDocument.findFirst({
      where: {
        id: application.agreementDocumentId,
        tenantId: tenant.id,
        clientId: application.clientId,
        docType: "CREDIT_AGREEMENT",
        fileName: `credit-agreement-${id}.pdf`,
        deletedAt: null,
        storagePath: { not: null },
      },
    })

    if (existingDoc?.storagePath) {
      if (
        existingDoc.contentSha256 !== application.agreementDocumentSha256 ||
        !isSha256Digest(existingDoc.contentSha256)
      ) {
        return NextResponse.json(
          {
            error: "The agreement document metadata no longer matches the generated legal artifact.",
            agreementIntegrity: "metadata_mismatch",
          },
          { status: 422 },
        )
      }
      // POPIA: log access to the stored credit-agreement ClientDocument before
      // serving bytes — same contract as app/api/documents/[id]/view.
      await prisma.documentAccessLog.create({
        data: {
          documentId: existingDoc.id,
          accessorType: access.type,
          accessorId: access.type === "staff" ? access.user.id : access.clientId,
          action: "view",
          ipAddress: req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
      let buffer: Buffer
      try {
        buffer = await readFile(existingDoc.storagePath)
      } catch {
        return NextResponse.json(
          {
            error: "The bound agreement bytes are unavailable and require compliance reconciliation.",
            agreementIntegrity: "bytes_missing",
          },
          { status: 422 },
        )
      }
      if (!documentBytesMatchSha256(buffer, application.agreementDocumentSha256)) {
        return NextResponse.json(
          {
            error: "The agreement bytes failed their integrity check and cannot be served.",
            agreementIntegrity: "content_mismatch",
          },
          { status: 422 },
        )
      }
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="agreement-${id}.pdf"`,
        },
      })
    }

    // No persisted agreement exists. Do NOT serve an ephemeral, on-the-fly
    // re-render of a legal artefact: it bypasses the POPIA DocumentAccessLog
    // above (there is no documentId to log against) and is not the recorded
    // document. The agreement must be generated first via POST, which persists
    // it and sets agreementGeneratedAt (the portal/staff view gates on that).
    return NextResponse.json(
      {
        error: "The application-bound agreement document is missing and requires compliance reconciliation.",
        agreementIntegrity: "document_missing",
      },
      { status: 422 },
    )
  })
}

export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return await withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json() as { initiationFeePayment?: unknown }
    const election = body.initiationFeePayment
    if (election !== "DEFERRED" && election !== "UPFRONT") {
      return NextResponse.json(
        { error: "initiationFeePayment must be DEFERRED or UPFRONT" },
        { status: 400 },
      )
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        updatedAt: true,
        initiationFeePayment: true,
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    if (application.status !== "UNDER_REVIEW") {
      return NextResponse.json(
        { error: "The initiation-fee election must be recorded while the application is under review." },
        { status: 409 },
      )
    }
    if (application.initiationFeePayment === election) {
      return NextResponse.json({ ok: true, initiationFeePayment: election })
    }

    const changed = await prisma.$transaction(async (tx) => {
      const updated = await tx.loanApplication.updateMany({
        where: {
          id,
          tenantId: tenant.id,
          status: "UNDER_REVIEW",
          updatedAt: application.updatedAt,
        },
        data: { initiationFeePayment: election },
      })
      if (updated.count !== 1) return false
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INITIATION_FEE_ELECTION_RECORDED,
          entity: "LoanApplication",
          entityId: id,
          oldValue: { initiationFeePayment: application.initiationFeePayment },
          newValue: { initiationFeePayment: election },
        },
      })
      return true
    })
    if (!changed) {
      return NextResponse.json(
        { error: "Application changed before the election could be saved; refresh and try again." },
        { status: 409 },
      )
    }
    return NextResponse.json({ ok: true, initiationFeePayment: election })
  })
}

export async function POST(_req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(_req, async (tenant) => {
    const { id } = await params

    // The consumer's NCA s.101 initiation-fee choice is captured before
    // approval. The optional body is only a consistency echo from the UI; it
    // must never change the frozen election while generating the agreement.
    let feeChoice: "DEFERRED" | "UPFRONT" | null = null
    let regenerate = false
    try {
      const body = await _req.json()
      if (body?.initiationFeePayment === "DEFERRED" || body?.initiationFeePayment === "UPFRONT") {
        feeChoice = body.initiationFeePayment
      }
      // Explicit staff request to supersede an UNSIGNED agreement artifact
      // (e.g. after a template correction). Never implicit: the default POST
      // stays idempotent.
      regenerate = body?.regenerate === true
    } catch {
      // no JSON body — leave feeChoice null
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        tenantId: true,
        status: true,
        updatedAt: true,
        reference: true,
        agreementType: true,
        clientId: true,
        agreementGeneratedAt: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        agreementSignedAt: true,
        agreementCountersignedAt: true,
        initiationFeePayment: true,
        affordabilityResult: true,
        submittedAt: true,
        appliedAmount: true,
        appliedTermDays: true,
        approvedAmount: true,
        approvedTermDays: true,
        productId: true,
        existingDebtObligations: true,
        bureauOverrideReason: true,
        bureauOverrideById: true,
        bureauOverrideAt: true,
        bureauReviewGeneration: true,
        creditLifeElection: true,
        creditLifeProductId: true,
        creditLifeProductName: true,
        creditLifeInsurerId: true,
        creditLifeInsurerName: true,
        creditLifeMonthlyPremiumCents: true,
        creditLifeDisclosureVersion: true,
        creditLifeDisclosureSha256: true,
        creditLifeDisclosureAcknowledgedAt: true,
        creditLifeDisclosureAcknowledgedBy: true,
        pasqVersion: true,
        pasqGeneratedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        pasqEvidence: true,
        pasqEvidenceSha256: true,
        pasqAcknowledgedAt: true,
        pasqAcknowledgedBy: true,
        pasqAcknowledgedSha256: true,
        approvedPasqDocumentSha256: true,
        product: {
          select: {
            interestRatePm: true,
            interestModel: true,
            initiationFeeModel: true,
            initiationFeePct: true,
            initiationFeeMax: true,
            monthlyServiceFee: true,
        productType: true,
          },
        },
        client: {
          select: {
            id: true,
            updatedAt: true,
            firstName: true,
            lastName: true,
            idNumber: true,
            gender: true,
            dateOfBirth: true,
            addressLine1: true,
            city: true,
            suburb: true,
            province: true,
            postalCode: true,
            phone: true,
            grossMonthlyIncome: true,
            monthlyIncome: true,
            monthlyExpenses: true,
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
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The credit agreement is a consumer NCA document; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (application.status !== "APPROVED") {
      return NextResponse.json({ error: "Application must be approved first" }, { status: 400 })
    }

    // A signed legal artefact is immutable. Downloads use GET; POST must never
    // create a replacement document behind an existing signature.
    if (application.agreementSignedAt) {
      return NextResponse.json(
        { error: "The signed agreement is immutable. Use the agreement view to download it." },
        { status: 409 },
      )
    }

    // NCA s.92(1) requires the PASQ to be given before the agreement is entered
    // into, not before an unsigned draft is prepared. Staff may therefore
    // prepare both documents as one signing packet; the sign route records the
    // exact PASQ acknowledgement and agreement signature atomically.
    const ceremonyStep = !application.pasqDocumentId || !application.pasqGeneratedAt
      ? {
          error: "The quotation has not been issued yet. Issue the consumer's Pre-Agreement Statement & Quotation before generating the agreement.",
          ceremonyState: "quotation_not_issued" as const,
        }
      : application.pasqAcknowledgedAt
        && (application.approvedPasqDocumentSha256 !== application.pasqDocumentSha256
          || application.pasqAcknowledgedSha256 !== application.pasqDocumentSha256
        )
        ? {
              error: "The acknowledged quotation does not match the one currently bound to this application. Re-issue the quotation and have the consumer acknowledge it again.",
              ceremonyState: "acknowledgement_stale" as const,
            }
        : null
    if (ceremonyStep) {
      return NextResponse.json(ceremonyStep, { status: 409 })
    }

    if (feeChoice && feeChoice !== application.initiationFeePayment) {
      return NextResponse.json(
        {
          error: "The initiation-fee election is part of the affordability decision. Return the application to review, save the election, and approve it again before generating the agreement.",
        },
        { status: 409 },
      )
    }

    let supersededAgreement: {
      documentId: string
      documentSha256: string
      generatedAt: Date
    } | null = null
    if (application.agreementGeneratedAt) {
      if (
        !application.agreementDocumentId
        || !isSha256Digest(application.agreementDocumentSha256)
      ) {
        return NextResponse.json(
          {
            error: "This legacy agreement must be bound to its stored bytes by the audited agreement-integrity backfill before it can be used.",
            agreementIntegrity: "legacy_backfill_required",
          },
          { status: 422 },
        )
      }
      try {
        const existing = await findCommittedAgreementArtifact({
          tenantId: tenant.id,
          clientId: application.clientId,
          applicationId: id,
          documentId: application.agreementDocumentId,
          documentSha256: application.agreementDocumentSha256,
        })
        if (existing && !regenerate) return NextResponse.json(existing)
        if (!existing) {
          return NextResponse.json(
            {
              error: "The existing agreement binding does not match its immutable generation evidence.",
              agreementIntegrity: "binding_mismatch",
            },
            { status: 422 },
          )
        }
      } catch {
        return NextResponse.json(
          {
            error: "The existing agreement could not be verified against managed storage.",
            agreementIntegrity: "verification_unavailable",
          },
          { status: 503 },
        )
      }
      // Regeneration: supersede the verified, UNSIGNED artifact. Once any
      // signature exists the document is contractual evidence and the only
      // road back is the explicit return-to-review transition.
      if (application.agreementSignedAt || application.agreementCountersignedAt) {
        return NextResponse.json(
          {
            error: "A signed agreement cannot be regenerated. Use Return to review if the application must be re-papered.",
            agreementIntegrity: "already_signed",
          },
          { status: 409 },
        )
      }
      supersededAgreement = {
        documentId: application.agreementDocumentId,
        documentSha256: application.agreementDocumentSha256,
        generatedAt: application.agreementGeneratedAt,
      }
    }

    // In normal generation the anchor must still be EMPTY at the locked
    // re-checks; in regeneration it must still be EXACTLY the artifact this
    // request read and verified — anything else means a concurrent write.
    const agreementAnchorMoved = (app: {
      agreementGeneratedAt: Date | null
      agreementDocumentId: string | null
      agreementDocumentSha256: string | null
    }): boolean =>
      supersededAgreement
        ? app.agreementGeneratedAt?.getTime()
            !== supersededAgreement.generatedAt.getTime()
          || app.agreementDocumentId !== supersededAgreement.documentId
          || app.agreementDocumentSha256 !== supersededAgreement.documentSha256
        : app.agreementGeneratedAt !== null
          || app.agreementDocumentId !== null
          || app.agreementDocumentSha256 !== null

    const artifactIdempotencyKey = agreementArtifactKey(tenant.id, id)
    const outstandingArtifact = await prisma.complianceRecord.findUnique({
      where: { idempotencyKey: artifactIdempotencyKey },
      select: { id: true, tenantId: true, status: true, data: true, createdAt: true },
    })
    if (outstandingArtifact) {
      const manifest = readAgreementArtifactManifest(outstandingArtifact.data)
      if (
        outstandingArtifact.tenantId !== tenant.id
        || outstandingArtifact.status !== "PENDING"
        || !manifest
        || manifest.applicationId !== id
        || (manifest.lifecycle !== "STAGING" && manifest.lifecycle !== "RECONCILING")
      ) {
        return NextResponse.json(
          {
            error: "Agreement artifact reconciliation is required before generation can continue.",
            agreementIntegrity: "staging_reconciliation_required",
          },
          { status: 503 },
        )
      }
      let reconcilingManifest = manifest
      let recoveryReason = "Resumed cleanup of an interrupted agreement-artifact reconciliation before retry."
      if (manifest.lifecycle === "STAGING") {
        const stagedAt = new Date(manifest.stagedAt)
        const leaseActive = Number.isFinite(stagedAt.getTime())
          && stagedAt.getTime() > Date.now() - AGREEMENT_STAGING_LEASE_MS
        if (leaseActive) {
          return NextResponse.json(
            {
              error: "Agreement generation is already in progress.",
              agreementIntegrity: "staging_in_progress",
            },
            { status: 409 },
          )
        }
        reconcilingManifest = {
          ...manifest,
          lifecycle: "RECONCILING",
        }
        recoveryReason = "Recovered an expired agreement-artifact staging lease before retry."
        const claimed = await prisma.$transaction(async (tx) => {
          const updated = await tx.complianceRecord.updateMany({
            where: {
              id: outstandingArtifact.id,
              tenantId: tenant.id,
              idempotencyKey: artifactIdempotencyKey,
              status: "PENDING",
              data: { path: ["lifecycle"], equals: "STAGING" },
            },
            data: { data: reconcilingManifest as unknown as Prisma.InputJsonValue },
          })
          if (updated.count !== 1) return false
          await tx.auditLog.create({
            data: {
              tenantId: tenant.id,
              userId: guard.user.id,
              userEmail: guard.user.email,
              action: AuditAction.AGREEMENT_ARTIFACT_STAGING_RECOVERY_STARTED,
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
          return NextResponse.json(
            {
              error: "The agreement artifact changed while stale recovery was starting; refresh before retry.",
              agreementIntegrity: "staging_reconciliation_required",
            },
            { status: 503 },
          )
        }
      }
      const recovered = await markAgreementStagingFailed({
        tenantId: tenant.id,
        applicationId: id,
        stagingId: outstandingArtifact.id,
        idempotencyKey: artifactIdempotencyKey,
        manifest: reconcilingManifest,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: recoveryReason,
        expectedLifecycle: "RECONCILING",
      })
      if (!recovered) {
        return NextResponse.json(
          {
            error: "The expired agreement artifact could not be reconciled safely.",
            agreementIntegrity: "staging_reconciliation_required",
          },
          { status: 503 },
        )
      }
    }

    const [bureauCheck, tenantConfig] = await Promise.all([
      application.bureauReviewGeneration
        ? prisma.creditBureauCheck.findFirst({
            where: {
              tenantId: tenant.id,
              applicationId: id,
              clientId: application.clientId,
              reviewGeneration: application.bureauReviewGeneration,
              ok: true,
              createdAt: { gte: bureauStalenessCutoff() },
              provider: "experian",
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
      prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: {
          ndiBufferPct: true,
          bureauMinScore: true,
          bureauBlockAdverse: true,
        },
      }),
    ])
    const currentApproval = verifyCurrentAffordabilityApproval({
      application,
      bureauCheck,
      tenantConfig,
      requirePasqAcknowledgement: false,
    })
    if (!currentApproval.ok) {
      return NextResponse.json(
        {
          error: "Current affordability, bureau, debt, or pricing evidence no longer matches the approval. Return the application to review and approve it again before generating an agreement.",
          affordabilitySnapshot: currentApproval.reason,
        },
        { status: 409 },
      )
    }
    const affordabilityStore = readAffordabilitySnapshotStore(application.affordabilityResult)
    const approvalSnapshot = currentApproval.approval
    if (!(application.pasqGeneratedAt instanceof Date)) {
      return NextResponse.json(
        {
          error: "Agreement generation requires the approved PASQ calculation date.",
          affordabilitySnapshot: "pasq_changed",
        },
        { status: 409 },
      )
    }
    const tenantRecord = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      include: { config: true },
    })
    if (!tenantRecord) throw new Error("Tenant not found")
    const providerIdentity = statutoryProviderIdentityFromTenant(tenantRecord)
    if (!providerIdentity) {
      return NextResponse.json(
        {
          error: "Agreement generation requires configured statutory provider identity.",
          agreementIntegrity: "provider_identity_missing",
        },
        { status: 503 },
      )
    }

    const creditLifeDisclosure = verifyStoredCreditLifeDisclosure(application, {
      principalCents: approvalSnapshot.inputs.principalCents,
      termDays: approvalSnapshot.inputs.termDays,
    })
    if (!creditLifeDisclosure.ok) {
      return NextResponse.json(
        {
          error: "Agreement generation requires an intact credit-life election and exact-premium disclosure captured before the PASQ.",
          missingComplianceEvidence: ["credit-life election"],
          creditLifeEvidence: creditLifeDisclosure.reason,
        },
        { status: 422 },
      )
    }
    const pasqBinding = verifyStoredPasqBinding(application, {
      tenantId: application.tenantId,
      applicationId: application.id,
      clientId: application.clientId,
      productId: application.productId,
      calculatorPricingFingerprint: approvalSnapshot.calculator.pricingFingerprint,
      creditLifeDisclosureSha256: creditLifeDisclosure.evidence.disclosureSha256,
      requireAcknowledgement: false,
      requireApprovalBinding: false,
    })
    if (!pasqBinding.ok) {
      return NextResponse.json(
        {
          error: "Agreement generation requires the exact PASQ acknowledged by the client and bound at approval.",
          affordabilitySnapshot: "pasq_changed",
          pasqEvidence: pasqBinding.reason,
        },
        { status: 409 },
      )
    }
    const pasqArtifact = await verifyPasqDocumentArtifact(prisma, {
      tenantId: tenant.id,
      clientId: application.clientId,
      documentId: pasqBinding.documentId,
      documentSha256: pasqBinding.documentSha256,
    })
    if (!pasqArtifact.ok) {
      return NextResponse.json(
        {
          error: "Agreement generation requires the intact application-bound PASQ PDF.",
          affordabilitySnapshot: "pasq_changed",
          pasqDocument: pasqArtifact.reason,
        },
        { status: 409 },
      )
    }
    const agreementGeneratedAt = new Date()
    let contractEvidence
    let quoteValidUntilDate: string
    try {
      quoteValidUntilDate = await quotationValidUntilDateFromDatabase(
        prisma,
        new Date(pasqBinding.evidence.calculator.startDate),
      )
      // The quote's money and pricing remain exact for its statutory binding
      // window. Rebase only the date-bearing schedule to the agreement
      // establishment instant so the final agreement shows its real payment
      // dates without shortening the consumer's term.
      contractEvidence = createAffordabilityContractEvidence(
        approvalSnapshot,
        agreementGeneratedAt,
        {
          documentSha256: pasqBinding.documentSha256,
          calculator: pasqBinding.evidence.calculator,
          quoteValidUntilDate,
        },
      )
    } catch {
      return NextResponse.json(
        {
          error: "The acknowledged PASQ schedule is stale or no longer matches the approved pricing. Return the application to review, generate a current PASQ, and obtain the client's acknowledgement again.",
          pasqEvidence: "schedule_or_pricing_changed",
        },
        { status: 409 },
      )
    }
    const calc = loanCalculationFromEvidence(contractEvidence.calculator)
    const startDate = new Date(contractEvidence.calculator.startDate)
    const maturityDate = calc.schedule.at(-1)?.dueDate ?? (() => {
      const fallback = new Date(startDate)
      fallback.setDate(fallback.getDate() + approvalSnapshot.inputs.termDays)
      return fallback
    })()
    const configuredBundleDecision = creditLifeAutoBundleDecision(
      approvalSnapshot.inputs.principalCents,
    )
    if (
      creditLifeDisclosure.evidence.election === "ACCEPTED"
      && !configuredBundleDecision.eligible
    ) {
      return NextResponse.json(
        {
          error: "The accepted credit-life election is no longer available for this application. Return the application to draft and capture the client's current election before generating the agreement.",
          creditLifeEvidence: "availability_changed",
        },
        { status: 409 },
      )
    }
    const creditLifeAutoBundleEligible =
      creditLifeDisclosure.evidence.election === "ACCEPTED"
      && configuredBundleDecision.eligible
    // Null exactly when no cover was offered, which can only be a decline, so
    // every consumer below is already gated on creditLifeAutoBundleEligible.
    const creditLifeOfferBinding: CreditLifeOfferBinding | null =
      creditLifeDisclosure.evidence.productId !== null
      && creditLifeDisclosure.evidence.productName !== null
      && creditLifeDisclosure.evidence.insurerId !== null
      && creditLifeDisclosure.evidence.insurerName !== null
        ? {
            productId: creditLifeDisclosure.evidence.productId,
            productName: creditLifeDisclosure.evidence.productName,
            insurerId: creditLifeDisclosure.evidence.insurerId,
            insurerName: creditLifeDisclosure.evidence.insurerName,
          }
        : null
    if (creditLifeAutoBundleEligible && !creditLifeOfferBinding) {
      return NextResponse.json(
        {
          error: "The accepted credit-life election is missing its product and insurer identity. Return the application to draft and capture the client's current election before generating the agreement.",
          creditLifeEvidence: "availability_changed",
        },
        { status: 409 },
      )
    }
    if (
      creditLifeAutoBundleEligible
      && creditLifeOfferBinding
      && !await currentCreditLifeOfferIsActive(tenant.id, creditLifeOfferBinding)
    ) {
      return NextResponse.json(
        {
          error: "The accepted credit-life product or insurer is no longer active. Return the application to draft and obtain a current election before generating the agreement.",
          creditLifeEvidence: "availability_changed",
        },
        { status: 409 },
      )
    }
    // Built through the SHARED mapping so countersignature can reproduce this
    // exact document byte-for-byte before stamping the executed artifact onto
    // it. A second copy of this mapping could silently disagree and mint an
    // executed agreement whose content differs from the one the consumer
    // signed. See lib/pdf/agreement-render-input.ts.
    const agreementRenderInput = buildAgreementRenderInput({
      providerIdentity,
      client: application.client,
      application: {
        reference: application.reference,
        agreementType: application.agreementType,
      },
      approvalInputs: {
        termDays: approvalSnapshot.inputs.termDays,
        interestRatePm: approvalSnapshot.inputs.interestRatePm,
        interestModel: approvalSnapshot.inputs.interestModel,
        monthlyServiceFeeCents: approvalSnapshot.inputs.monthlyServiceFeeCents,
        initiationFeePayment: approvalSnapshot.inputs.initiationFeePayment,
      },
      calc,
      startDate,
      maturityDate,
      quotePresentedAt: new Date(pasqBinding.evidence.calculator.startDate),
      quoteValidUntilDate,
      creditLifeAutoBundleEligible,
      creditLife: creditLifeOfferBinding
        ? {
            elected: creditLifeAutoBundleEligible,
            productName: creditLifeOfferBinding.productName,
            insurerName: creditLifeOfferBinding.insurerName,
            monthlyPremiumCents: creditLifeDisclosure.evidence.monthlyPremiumCents,
            premiumPeriods: pasqBinding.evidence.creditLife.premiumPeriods,
            totalPremiumCents: pasqBinding.evidence.creditLife.totalPremiumCents,
            billing: pasqBinding.evidence.billing,
          }
        : undefined,
    })
    const { bytes: pdf, signatureAnchors } = await generateCreditAgreementPdfWithAnchors({
      variant: "agreement",
      ...agreementRenderInput,
      // Countersignature stamps THESE stored bytes rather than re-rendering,
      // so the executed agreement keeps the logo the consumer saw.
      logo: await getLenderLogo(tenant.id),
      // Same value the quotation carries, so the two halves of a printed packet
      // read as ONE ceremony and a page from elsewhere stands out.
      ceremonyMarker: ceremonyMarkerFor(application.pasqEvidenceSha256),
    } as Parameters<typeof generateCreditAgreementPdfWithAnchors>[0])

    const contentSha256 = sha256DocumentBytes(pdf)
    const agreementDocumentId = randomUUID()
    const storageKey = `agreement-${agreementDocumentId}`
    const storagePath = managedStoragePath(storageKey, "application/pdf")
    const fileSize = pdf.length
    const stagedAt = new Date()
    const manifest: AgreementArtifactManifest = {
      kind: AGREEMENT_ARTIFACT_KIND,
      lifecycle: "STAGING",
      applicationId: id,
      documentId: agreementDocumentId,
      documentSha256: contentSha256,
      storagePath,
      fileName: `credit-agreement-${id}.pdf`,
      fileSize,
      stagedAt: stagedAt.toISOString(),
      creditLifeAutoBundleEligible,
      creditLifeElection: creditLifeDisclosure.evidence.election,
      // Explicit null, NOT undefined: this manifest is persisted as JSON, and
      // JSON.stringify DROPS undefined-valued keys. Disbursement re-reads the
      // stored artifact and compares these with strict !== against the
      // disclosure evidence (which yields null), so a dropped key would fail
      // every no-offer disbursement after the loan row was already created.
      creditLifeProductId: creditLifeDisclosure.evidence.productId,
      creditLifeProductName: creditLifeDisclosure.evidence.productName,
      creditLifeInsurerId: creditLifeDisclosure.evidence.insurerId,
      creditLifeInsurerName: creditLifeDisclosure.evidence.insurerName,
      creditLifeMonthlyPremiumCents: creditLifeDisclosure.evidence.monthlyPremiumCents,
      creditLifeDisclosureVersion: creditLifeDisclosure.evidence.version,
      creditLifeDisclosureSha256: creditLifeDisclosure.evidence.disclosureSha256,
      pasqVersion: pasqBinding.evidence.version,
      pasqDocumentId: pasqBinding.documentId,
      pasqDocumentSha256: pasqBinding.documentSha256,
      pasqEvidenceSha256: pasqBinding.evidence.evidenceSha256,
      pasqTotalCostOfCreditCents: pasqBinding.evidence.totalCostOfCreditCents,
      // Explicit null, not undefined — a dropped key and a recorded "no anchors"
      // must be indistinguishable to the countersign route, and both must mean
      // "append an execution page".
      signatureAnchors: signatureAnchors ?? null,
    }

    let staging: { id: string; reason: string | null }
    try {
      staging = await prisma.$transaction(async (tx) => {
        if (!await lockCurrentStatutoryProviderIdentity(
          tx,
          tenant.id,
          providerIdentity,
        )) {
          return { id: "", reason: "provider_identity_changed" }
        }
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
          requirePasqAcknowledgement: false,
        })
        if (!locked.ok) return { id: "", reason: locked.reason }
        const lockedPasqArtifact = await verifyPasqDocumentArtifact(tx, {
          tenantId: tenant.id,
          clientId: locked.application.clientId,
          documentId: pasqBinding.documentId,
          documentSha256: pasqBinding.documentSha256,
          lock: true,
        })
        if (!lockedPasqArtifact.ok) return { id: "", reason: "pasq_changed" }
        if (
          locked.application.updatedAt.toISOString() !== application.updatedAt.toISOString()
          || locked.application.client.updatedAt.toISOString() !== application.client.updatedAt.toISOString()
          || locked.approval.decisionFingerprint !== approvalSnapshot.decisionFingerprint
          || agreementAnchorMoved(locked.application)
        ) {
          return { id: "", reason: "application_changed" }
        }
        if (
          creditLifeAutoBundleEligible
          && creditLifeOfferBinding !== null
          && !await lockCurrentCreditLifeOffer(
            tx as unknown as Parameters<typeof lockCurrentCreditLifeOffer>[0],
            tenant.id,
            creditLifeOfferBinding,
          )
        ) {
          return { id: "", reason: "credit_life_offer_changed" }
        }
        const created = await tx.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            type: "AGREEMENT_ARTIFACT",
            referenceId: id,
            idempotencyKey: artifactIdempotencyKey,
            status: "PENDING",
            dueDate: new Date(stagedAt.getTime() + AGREEMENT_STAGING_LEASE_MS),
            data: manifest as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.AGREEMENT_ARTIFACT_STAGED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              stagingId: created.id,
              lifecycle: "STAGING",
              documentId: agreementDocumentId,
              documentSha256: contentSha256,
              expectedFileSize: fileSize,
              creditLifeAutoBundleEligible,
              creditLifeElection: creditLifeDisclosure.evidence.election,
              creditLifeDisclosureSha256: creditLifeDisclosure.evidence.disclosureSha256,
              pasqVersion: pasqBinding.evidence.version,
              pasqDocumentId: pasqBinding.documentId,
              pasqDocumentSha256: pasqBinding.documentSha256,
              pasqEvidenceSha256: pasqBinding.evidence.evidenceSha256,
            },
          },
        })
        return { id: created.id, reason: null }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json(
          {
            error: "Agreement generation is already in progress.",
            agreementIntegrity: "staging_in_progress",
          },
          { status: 409 },
        )
      }
      throw error
    }
    if (!staging.id) {
      if (staging.reason === "kyc_changed") {
        return NextResponse.json(
          {
            error: "The client's KYC evidence does not meet the identity bar for a binding agreement.",
            affordabilitySnapshot: "kyc_changed",
            remediation: "Capture a selfie or record an in-person verification on the client's KYC tab. If a verified document itself changed, return the application to review and re-verify first.",
          },
          { status: 422 },
        )
      }
      if (staging.reason === "credit_life_offer_changed") {
        return NextResponse.json(
          {
            error: "The accepted credit-life product or insurer changed before the agreement could be staged. Return the application to draft and obtain a current election.",
            creditLifeEvidence: "availability_changed",
          },
          { status: 409 },
        )
      }
      if (staging.reason === "provider_identity_changed") {
        return NextResponse.json(
          {
            error: "The statutory credit-provider identity changed before the agreement could be staged. Refresh and generate the legal document again.",
            agreementIntegrity: "provider_identity_changed",
          },
          { status: 409 },
        )
      }
      return NextResponse.json(
        {
          error: "Affordability evidence changed before the agreement artifact could be staged; refresh and try again.",
          affordabilitySnapshot: staging.reason,
        },
        { status: 409 },
      )
    }

    const failStaging = (reason: string) => markAgreementStagingFailed({
      tenantId: tenant.id,
      applicationId: id,
      stagingId: staging.id,
      idempotencyKey: artifactIdempotencyKey,
      manifest,
      userId: guard.user.id,
      userEmail: guard.user.email,
      reason,
      expectedLifecycle: "STAGING",
    })

    try {
      await prisma.$transaction(async (tx) => {
        const stagingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "ComplianceRecord"
          WHERE "id" = ${staging.id}
            AND "tenantId" = ${tenant.id}
            AND "idempotencyKey" = ${artifactIdempotencyKey}
            AND "status" = 'PENDING'::"ComplianceStatus"
            AND "data" #>> '{lifecycle}' = 'STAGING'
          FOR UPDATE
        `)
        if (stagingRows[0]?.id !== staging.id) {
          throw new Error("Agreement artifact staging lease is no longer active")
        }
        const stored = await saveFileToManagedPath(pdf, "application/pdf", storageKey)
        if (stored.storagePath !== storagePath || stored.fileSize !== fileSize) {
          throw new Error("Managed storage returned metadata that differs from the staged manifest")
        }
        const persistedBytes = await readFile(storagePath)
        if (!documentBytesMatchSha256(persistedBytes, contentSha256)) {
          throw new Error("Managed storage bytes did not match the staged SHA-256 digest")
        }
      })
    } catch (error) {
      const cleaned = await failStaging(
        `Managed storage write/read failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return NextResponse.json(
        {
          error: cleaned
            ? "The generated agreement could not be written and verified in managed storage."
            : "The failed agreement artifact requires storage reconciliation.",
          agreementIntegrity: cleaned ? "staging_failed" : "staging_reconciliation_required",
        },
        { status: cleaned ? 500 : 503 },
      )
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        if (!await lockCurrentStatutoryProviderIdentity(
          tx,
          tenant.id,
          providerIdentity,
        )) {
          return {
            document: null,
            reason: "provider_identity_changed" as const,
          }
        }
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
          requirePasqAcknowledgement: false,
        })
        if (!locked.ok) return { document: null, reason: locked.reason }
        const lockedPasqArtifact = await verifyPasqDocumentArtifact(tx, {
          tenantId: tenant.id,
          clientId: locked.application.clientId,
          documentId: pasqBinding.documentId,
          documentSha256: pasqBinding.documentSha256,
          lock: true,
        })
        if (!lockedPasqArtifact.ok) {
          return { document: null, reason: "pasq_changed" as const }
        }
        if (
          locked.application.updatedAt.toISOString() !== application.updatedAt.toISOString() ||
          locked.application.client.updatedAt.toISOString() !== application.client.updatedAt.toISOString() ||
          locked.approval.decisionFingerprint !== approvalSnapshot.decisionFingerprint ||
          agreementAnchorMoved(locked.application)
        ) {
          return { document: null, reason: "application_changed" as const }
        }
        if (
          creditLifeAutoBundleEligible
          && creditLifeOfferBinding !== null
          && !await lockCurrentCreditLifeOffer(
            tx as unknown as Parameters<typeof lockCurrentCreditLifeOffer>[0],
            tenant.id,
            creditLifeOfferBinding,
          )
        ) {
          return {
            document: null,
            reason: "credit_life_offer_changed" as const,
          }
        }
        // LOAD-BEARING COUPLING: agreementGeneratedAt and the validated
        // affordability CONTRACT must land in this ONE statement. The
        // database's pricing reconciliation (guardSignedDebitMandateAuthority,
        // contract_install branch) only fires when the contract object
        // changes in the same write — generating an agreement without
        // installing the contract would silently skip the "quotation prices
        // what was approved" check. Do not split this update.
        const changed = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            agreementSignedAt: null,
            updatedAt: locked.application.updatedAt,
          },
          data: {
            agreementGeneratedAt,
            agreementDocumentId,
            agreementDocumentSha256: contentSha256,
            affordabilityResult: withAffordabilityContract(
              affordabilityStore,
              contractEvidence,
            ) as unknown as Prisma.InputJsonValue,
          },
        })
        if (changed.count !== 1) {
          return { document: null, reason: "application_changed" as const }
        }

        const created = await tx.clientDocument.create({
          data: {
            id: agreementDocumentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            docType: "CREDIT_AGREEMENT",
            fileUrl: `/api/documents/${agreementDocumentId}/view`,
            fileName: `credit-agreement-${id}.pdf`,
            storagePath,
            fileSize,
            mimeType: "application/pdf",
            contentSha256,
            uploadedByType: "staff",
            uploadedById: guard.user.id,
            extractionStatus: "skipped",
            verified: false,
          },
        })

        if (supersededAgreement) {
          // The superseded draft is retired (soft-deleted), never destroyed:
          // bytes and access history stay on record, but no list, delivery or
          // signing surface may serve it again. Count is load-bearing — a
          // vanished or already-retired artifact means a concurrent writer.
          const retired = await tx.clientDocument.updateMany({
            where: {
              id: supersededAgreement.documentId,
              tenantId: tenant.id,
              clientId: application.clientId,
              docType: "CREDIT_AGREEMENT",
              contentSha256: supersededAgreement.documentSha256,
              deletedAt: null,
            },
            data: { deletedAt: agreementGeneratedAt },
          })
          if (retired.count !== 1) {
            // MUST throw, never return: a return from an interactive Prisma
            // transaction COMMITS — leaving the new binding installed with no
            // audit row while the caller deletes the new bytes as "failed".
            throw new Error("Superseded agreement draft changed before finalization")
          }
        }
        const completedAt = new Date()
        const completed = await tx.complianceRecord.updateMany({
          where: {
            id: staging.id,
            tenantId: tenant.id,
            idempotencyKey: artifactIdempotencyKey,
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
        if (completed.count !== 1) {
          throw new Error("Agreement artifact staging record changed before finalization")
        }
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.AGREEMENT_GENERATED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              documentId: created.id,
              documentSha256: contentSha256,
              approvalDecisionFingerprint: approvalSnapshot.decisionFingerprint,
              contractFingerprint: contractEvidence.fingerprint,
              contractEstablishedAt: contractEvidence.establishedAt,
              contractStartDate: contractEvidence.calculator.startDate,
              acceptedPasqContractFingerprint:
                acceptedPasqCalculatorFingerprint(contractEvidence),
              stagingId: staging.id,
              previousDocumentId: supersededAgreement?.documentId ?? null,
              previousDocumentSha256: supersededAgreement?.documentSha256 ?? null,
              previousDocumentRetained: supersededAgreement !== null,
              creditLifeAutoBundleEligible,
              creditLifeElection: creditLifeDisclosure.evidence.election,
              creditLifeMonthlyPremiumCents: creditLifeDisclosure.evidence.monthlyPremiumCents,
              creditLifeDisclosureSha256: creditLifeDisclosure.evidence.disclosureSha256,
              creditLifePremiumPeriods: pasqBinding.evidence.creditLife.premiumPeriods,
              creditLifeTotalPremiumCents: pasqBinding.evidence.creditLife.totalPremiumCents,
              pasqVersion: pasqBinding.evidence.version,
              pasqDocumentId: pasqBinding.documentId,
              pasqDocumentSha256: pasqBinding.documentSha256,
              pasqEvidenceSha256: pasqBinding.evidence.evidenceSha256,
              pasqTotalCostOfCreditCents: pasqBinding.evidence.totalCostOfCreditCents,
            },
          },
        })
        return { document: created, reason: null }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      if (!result.document) {
        const cleaned = await failStaging(
          `Agreement finalization rejected changed evidence: ${String(result.reason)}`,
        )
        if (result.reason === "kyc_changed" && cleaned) {
          return NextResponse.json(
            {
              error: "The client's KYC evidence no longer meets the identity bar for a binding agreement.",
              affordabilitySnapshot: "kyc_changed",
              remediation: "Capture a selfie or record an in-person verification on the client's KYC tab. If a verified document itself changed, return the application to review and re-verify first.",
              agreementIntegrity: "staging_failed",
            },
            { status: 422 },
          )
        }
        if (result.reason === "credit_life_offer_changed" && cleaned) {
          return NextResponse.json(
            {
              error: "The accepted credit-life product or insurer changed before the agreement could be recorded. Return the application to draft and obtain a current election.",
              creditLifeEvidence: "availability_changed",
              agreementIntegrity: "staging_failed",
            },
            { status: 409 },
          )
        }
        if (result.reason === "provider_identity_changed" && cleaned) {
          return NextResponse.json(
            {
              error: "The statutory credit-provider identity changed before the agreement could be recorded. Refresh and generate the legal document again.",
              agreementIntegrity: "provider_identity_changed",
            },
            { status: 409 },
          )
        }
        return NextResponse.json(
          {
            error: cleaned
              ? "Affordability evidence changed before the agreement could be recorded; refresh and try again."
              : "The staged agreement requires reconciliation before retry.",
            affordabilitySnapshot: result.reason,
            agreementIntegrity: cleaned ? "staging_failed" : "staging_reconciliation_required",
          },
          { status: cleaned ? 409 : 503 },
        )
      }
      return NextResponse.json(result.document)
    } catch (error) {
      // A transaction exception can be a lost COMMIT acknowledgement. Resolve
      // the durable audit+document state before deleting any bytes.
      try {
        const committed = await findCommittedAgreementArtifact({
          tenantId: tenant.id,
          clientId: application.clientId,
          applicationId: id,
          documentId: agreementDocumentId,
          documentSha256: contentSha256,
        })
        if (committed) return NextResponse.json(committed)
      } catch {
        return NextResponse.json(
          {
            error: "The agreement commit outcome could not be resolved; retained staged bytes require reconciliation.",
            agreementIntegrity: "commit_outcome_unknown",
          },
          { status: 503 },
        )
      }

      const cleaned = await failStaging(
        `Agreement database finalization failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return NextResponse.json(
        {
          error: cleaned
            ? "The agreement could not be finalized and its staged bytes were removed."
            : "The agreement commit failed and retained staged bytes require reconciliation.",
          agreementIntegrity: cleaned ? "staging_failed" : "staging_reconciliation_required",
        },
        { status: cleaned ? 500 : 503 },
      )
    }
  })
}
