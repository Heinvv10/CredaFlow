import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import {
  affordabilityContractCanBeDisbursed,
  affordabilityContractEvidenceIsIntact,
  readAffordabilitySnapshotStore,
} from "@/lib/affordability/snapshot"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import { verifyStoredCreditLifeDisclosure } from "@/lib/insurance/credit-life-election.server"
import { verifyStoredPasqBinding } from "@/lib/compliance/pasq"
import { verifyPasqDocumentArtifact } from "@/lib/compliance/pasq-document.server"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
  verifyStoredProviderCountersign,
} from "@/lib/compliance/provider-countersign"
import { documentBytesMatchSha256, sha256DocumentBytes } from "@/lib/documents/content-integrity"
import {
  readFile,
  managedStoragePath,
  saveFileToManagedPath,
  deleteManagedFileStrict,
} from "@/lib/storage"
import { randomUUID } from "node:crypto"
import {
  stampExecutedAgreement,
  readAgreementSignatureAnchors,
  isReturnedPacketReference,
  type ExecutedAgreementMethod,
  type ExecutedAgreementIdentity,
} from "@/lib/pdf/executed-agreement"
import { ceremonyMarkerFor } from "@/lib/pdf/agreement-render-input"
import { statutoryProviderIdentityFromTenant } from "@/lib/compliance/statutory-provider-identity.server"
import { EntityBorrowerError, hasClientBorrowerId } from "@/lib/borrower"
import { databaseGuardRefusal } from "@/lib/db-guard-refusal"
import { auditRefusal } from "@/lib/audit-refusals"
import {
  isSegregationOfDutiesRequired,
  segregationOfDutiesConflict,
  SEGREGATION_OF_DUTIES_REFUSALS,
} from "@/lib/security/segregation-of-duties"

type RouteCtx = { params: Promise<{ id: string }> }

class ProviderCountersignError extends Error {
  constructor(readonly reason: string) {
    super("Provider countersign evidence changed")
    this.name = "ProviderCountersignError"
  }
}

/**
 * Record that a signed credit agreement is stranded in managed storage with no
 * row referencing it.
 *
 * Deliberately best-effort and never rethrows: the countersignature is already
 * failing, and losing the failure to an audit-write error would leave nothing
 * at all. Its own failure is swallowed only after the primary error has been
 * preserved by the caller.
 */
async function recordOrphanedExecutedArtifact(args: {
  tenantId: string
  applicationId: string
  userId: string
  userEmail: string
  storagePath: string
  sha256: string
  reason: string
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        userEmail: args.userEmail,
        action: AuditAction.AGREEMENT_ARTIFACT_STAGING_FAILED,
        entity: "LoanApplication",
        entityId: args.applicationId,
        newValue: {
          artifact: "EXECUTED_CREDIT_AGREEMENT",
          lifecycle: "ORPHANED",
          storagePath: args.storagePath,
          documentSha256: args.sha256,
          failure: "executed_artifact_orphaned",
          cleanupError: args.reason,
          remediation: "A signed credit agreement PDF is on disk with no ClientDocument row. Remove it or attach it deliberately; it is invisible to DSAR until then.",
        },
      },
    })
  } catch {
    // Nothing further can be done here without masking the real failure.
  }
}

/**
 * Render the executed agreement and stage its bytes in managed storage.
 *
 * Returns everything the transaction needs to record it. Throws
 * ProviderCountersignError when the evidence it depends on is missing or has
 * moved — the countersignature must then refuse rather than commit a
 * countersigned application with no artifact to show for it.
 */
async function prepareExecutedAgreement(args: {
  tenantId: string
  applicationId: string
  application: {
    clientId: string
    agreementDocumentId: string | null
    agreementDocumentSha256: string | null
    agreementSignedAt: Date | null
    agreementSignatureData: string | null
    pasqEvidenceSha256: string | null
  }
  signerUserId: string
  signerEmail: string
  signerRole: string
  providerSignature: string
  countersignedAt: Date
  applicationReference: string
}) {
  const { tenantId, applicationId, application, countersignedAt } = args
  if (
    !application.agreementDocumentId
    || !application.agreementDocumentSha256
    || !application.agreementSignedAt
    || !application.agreementSignatureData?.trim()
  ) {
    throw new ProviderCountersignError("agreement_document_changed")
  }

  // The name stamped on the document must be the name recorded against the
  // countersignature. It is read here and re-asserted against the LOCKED user
  // row inside the transaction, so a rename between the two cannot leave the
  // artifact and the audit record disagreeing about who signed.
  const signer = await prisma.user.findFirst({
    where: {
      id: args.signerUserId,
      tenantId,
      email: args.signerEmail,
      active: true,
    },
    select: { id: true, email: true, name: true, role: true },
  })
  if (!signer || signer.role !== args.signerRole) {
    throw new ProviderCountersignError("provider_signer_tenant_changed")
  }
  const countersignedByName = signer.name?.trim() || signer.email

  const agreementDocument = await prisma.clientDocument.findFirst({
    where: {
      id: application.agreementDocumentId,
      tenantId,
      clientId: application.clientId,
      docType: "CREDIT_AGREEMENT",
      fileName: `credit-agreement-${applicationId}.pdf`,
      deletedAt: null,
      verified: true,
      signatureState: "signed",
      contentSha256: application.agreementDocumentSha256,
      storagePath: { not: null },
    },
    select: { id: true, storagePath: true },
  })
  if (!agreementDocument?.storagePath) {
    throw new ProviderCountersignError("agreement_document_changed")
  }

  let agreementBytes: Buffer
  try {
    agreementBytes = await readFile(agreementDocument.storagePath)
  } catch {
    throw new ProviderCountersignError("agreement_document_bytes")
  }
  // The signatures are stamped onto THESE bytes, so this check is what makes
  // the executed artifact provably the document the consumer signed.
  if (!documentBytesMatchSha256(agreementBytes, application.agreementDocumentSha256)) {
    throw new ProviderCountersignError("agreement_document_bytes")
  }

  // Anchors say where this render put the blank signature rules. Absent for
  // agreements generated before they were recorded; the stamper then appends an
  // execution page instead of guessing a coordinate.
  const artifact = await prisma.complianceRecord.findFirst({
    where: {
      tenantId,
      type: "AGREEMENT_ARTIFACT",
      referenceId: applicationId,
      status: "COMPLETED",
      completedAt: { not: null },
      AND: [
        { data: { path: ["kind"], equals: "CREDIT_AGREEMENT_ARTIFACT" } },
        { data: { path: ["lifecycle"], equals: "COMPLETED" } },
        { data: { path: ["applicationId"], equals: applicationId } },
        { data: { path: ["documentId"], equals: application.agreementDocumentId } },
        { data: { path: ["documentSha256"], equals: application.agreementDocumentSha256 } },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true, data: true },
  })
  if (!artifact) throw new ProviderCountersignError("agreement_artifact_changed")
  const anchors = readAgreementSignatureAnchors(
    (artifact.data as Record<string, unknown> | null)?.signatureAnchors,
  )

  // Identity is PRINTED only on an appended execution page, so it is required
  // only when one is certain to be drawn. Demanding it on the stamped path too
  // would make a missing TenantConfig row block every countersignature in the
  // tenant — and the remedy the error names is "return to review", which
  // re-papers the loan, voids the consumer's signature and does not fix the
  // config. The body page already carries all of these identifiers. It is
  // still supplied whenever it is configured: stored anchors that point past
  // the document's pages also fall back to an execution page, which must name
  // the provider rather than fail as if the lender were unconfigured.
  const executionPageCertain = !anchors || isReturnedPacketReference(application.agreementSignatureData)
  let identity: ExecutedAgreementIdentity | undefined
  const [tenantRecord, client] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, include: { config: true } }),
    prisma.client.findFirst({
      where: { id: application.clientId, tenantId },
      select: { firstName: true, lastName: true, idNumber: true },
    }),
  ])
  const providerIdentity = tenantRecord
    ? statutoryProviderIdentityFromTenant(tenantRecord)
    : null
  // An NCA document naming no credit provider is not one this may emit.
  if ((!providerIdentity || !client) && executionPageCertain) {
    throw new ProviderCountersignError("provider_identity_missing")
  }
  if (providerIdentity && client) {
    identity = {
      lender: {
        legalName: providerIdentity.tenantName,
        ncrNumber: providerIdentity.statutoryNcrNumber,
      },
      clientName: `${client.firstName} ${client.lastName}`.trim(),
      clientIdNumber: client.idNumber,
      applicationReference: args.applicationReference,
    }
  }

  const stamped = await stampExecutedAgreement({
    agreementBytes,
    anchors,
    execution: {
      consumerSignature: application.agreementSignatureData,
      consumerSignedAt: application.agreementSignedAt,
      providerSignature: args.providerSignature,
      providerName: countersignedByName,
      countersignedAt,
    },
    ceremonyMarker: ceremonyMarkerFor(application.pasqEvidenceSha256),
    // Only used by the appended-page path, but always supplied: an execution
    // page separated from its agreement must still name the parties.
    identity,
  })

  const documentId = randomUUID()
  const storageKey = `agreement-executed-${documentId}`
  const storagePath = managedStoragePath(storageKey, "application/pdf")
  const sha256 = sha256DocumentBytes(stamped.bytes)

  // From here the bytes exist on disk. EVERY failure below must remove them:
  // the artifact is a full credit agreement carrying the consumer's signature,
  // ID number and address, and one with no ClientDocument row is reachable by
  // no DSAR and no POPIA erasure path, because nothing references it.
  try {
    const stored = await saveFileToManagedPath(stamped.bytes, "application/pdf", storageKey)
    if (stored.storagePath !== storagePath || stored.fileSize !== stamped.bytes.length) {
      throw new ProviderCountersignError("executed_artifact_storage")
    }
    // Read back rather than trust the write — the same proof POST /agreement
    // takes before it binds an artifact it will later be asked to produce.
    const persisted = await readFile(storagePath)
    if (!documentBytesMatchSha256(persisted, sha256)) {
      throw new ProviderCountersignError("executed_artifact_storage")
    }
  } catch (error) {
    try {
      await deleteManagedFileStrict(storagePath)
    } catch (cleanupError) {
      // Nothing references these bytes, so there is no ClientDocument row to
      // flag and no DSAR or POPIA erasure path can reach them. An HTTP response
      // is not a record — write the location to the audit log so ops can
      // reconcile it.
      await recordOrphanedExecutedArtifact({
        tenantId,
        applicationId,
        userId: args.signerUserId,
        userEmail: args.signerEmail,
        storagePath,
        sha256,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
      throw new ProviderCountersignError("executed_artifact_orphaned")
    }
    throw error instanceof ProviderCountersignError
      ? error
      : new ProviderCountersignError("executed_artifact_storage")
  }

  return {
    documentId,
    sha256,
    storagePath,
    fileSize: stamped.bytes.length,
    artifactRecordId: artifact.id,
    countersignedByName,
    method: stamped.method,
    consumerSignatureRendered: stamped.consumerSignatureRendered,
    providerSignatureRendered: stamped.providerSignatureRendered,
  }
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  let body: { signature?: unknown; attestation?: unknown }
  try {
    body = await req.json() as typeof body
  } catch {
    return NextResponse.json({ error: "A countersignature payload is required." }, { status: 400 })
  }
  const signature = typeof body.signature === "string" ? body.signature.trim() : ""
  if (signature.length === 0 || signature.length > 500_000 || body.attestation !== true) {
    return NextResponse.json(
      {
        error: "Type the provider representative signature and confirm the exact agreement attestation.",
      },
      { status: 422 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    if (!guard.user.tenantId || guard.user.tenantId !== tenant.id) {
      return NextResponse.json(
        { error: "The authenticated staff account is not assigned to this tenant." },
        { status: 403 },
      )
    }
    const { id } = await params
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        clientId: true,
        status: true,
        updatedAt: true,
        agreementGeneratedAt: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        agreementSignedAt: true,
        agreementSignedMethod: true,
        agreementSignedByUserId: true,
        agreementSignatureData: true,
        agreementCountersignedAt: true,
        agreementExecutedDocumentId: true,
        pasqEvidenceSha256: true,
        reference: true,
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // Countersigning a consumer credit agreement; an entity borrower is refused.
    if (!hasClientBorrowerId(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (application.status !== "APPROVED") {
      return NextResponse.json(
        { error: "Only an approved application can be countersigned." },
        { status: 409 },
      )
    }
    if (!application.agreementSignedAt) {
      return NextResponse.json(
        { error: "The consumer must sign the exact agreement before the provider countersigns." },
        { status: 422 },
      )
    }
    if (
      !application.agreementSignatureData?.trim()
      || (application.agreementSignedMethod !== "portal"
        && application.agreementSignedMethod !== "branch")
      || (
        application.agreementSignedMethod === "branch"
        && !application.agreementSignedByUserId?.trim()
      )
    ) {
      return NextResponse.json(
        {
          error: "The consumer signing record has no attributable typed or drawn signature artefact. Return the application to review and obtain a new signature.",
          countersignEvidence: "consumer_signature_missing",
        },
        { status: 422 },
      )
    }
    const expectedAgreementSignedAt = application.agreementSignedAt
    if (application.agreementCountersignedAt || application.agreementExecutedDocumentId) {
      return NextResponse.json({ error: "The agreement is already countersigned." }, { status: 409 })
    }
    // Before any rendering: the database refuses the same pair
    // (LoanApplication_z_guard_segregation_of_duties).
    const segregationOfDuties = await isSegregationOfDutiesRequired(tenant.id)
    const conflict = segregationOfDutiesConflict("countersign", guard.user.id, application)
    if (conflict && segregationOfDuties) {
      await auditRefusal({
        action: AuditAction.AGREEMENT_COUNTERSIGN_REFUSED,
        entity: "LoanApplication",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason: "segregation_of_duties",
        status: 403,
      })
      return NextResponse.json(
        { error: SEGREGATION_OF_DUTIES_REFUSALS[conflict], segregationOfDuties: conflict },
        { status: 403 },
      )
    }

    const countersignedAt = new Date()
    const signatureSha256 = providerCountersignatureSha256(signature)
    const ipAddress = recordedCallerIp(req)

    // ── The executed artifact ────────────────────────────────────────────────
    //
    // Prepared HERE, before the transaction, and verified inside it — the same
    // shape POST /agreement uses. Rendering a PDF and writing it to managed
    // storage are not transactional: doing them inside the transaction would
    // leave orphaned bytes behind on any rollback, and would hold serializable
    // locks across a filesystem write.
    //
    // Everything it consumes is pinned by digest, so an optimistic read is
    // safe: the stored agreement bytes are checked against
    // agreementDocumentSha256, and the transaction re-asserts that this is
    // still the bound document before the artifact is recorded.
    let executed: {
      documentId: string
      sha256: string
      storagePath: string
      fileSize: number
      artifactRecordId: string
      countersignedByName: string
      method: ExecutedAgreementMethod
      consumerSignatureRendered: boolean
      providerSignatureRendered: boolean
    }
    try {
      executed = await prepareExecutedAgreement({
        tenantId: tenant.id,
        applicationId: id,
        application,
        signerUserId: guard.user.id,
        signerEmail: guard.user.email,
        signerRole: guard.user.role,
        providerSignature: signature,
        countersignedAt,
        applicationReference: application.reference,
      })
    } catch (error) {
      if (error instanceof ProviderCountersignError) {
        // Distinct remedy: this one is a tenant configuration gap, and telling
        // staff to return the application to review would re-paper the loan
        // and void the consumer's signature without fixing anything.
        const identityFailure = error.reason === "provider_identity_missing"
        return NextResponse.json(
          {
            error: identityFailure
              ? "The statutory credit-provider identity is not configured, so the executed agreement cannot name the credit provider. Set the tenant's registered name and NCR number, then countersign again — do NOT return the application to review."
              : "The signed agreement artifact could not be read and executed; return the application to review and generate a new agreement.",
            countersignEvidence: error.reason,
          },
          { status: identityFailure ? 503 : 422 },
        )
      }
      throw error
    }

    /** Remove the staged artifact bytes when the countersignature does not commit. */
    const discardExecutedBytes = async () => {
      try {
        await deleteManagedFileStrict(executed.storagePath)
        return true
      } catch {
        return false
      }
    }

    try {
      const countersigned = await prisma.$transaction(async (tx) => {
        const providerRows = await tx.$queryRaw<Array<{
          id: string
          email: string
          name: string | null
          role: string
        }>>(Prisma.sql`
          SELECT
            "id",
            "email",
            "name",
            "role"::TEXT AS "role"
          FROM "User"
          WHERE "id" = ${guard.user.id}
            AND "tenantId" = ${tenant.id}
            AND "active" = TRUE
          FOR SHARE
        `)
        const providerSigner = providerRows[0]
        if (
          providerRows.length !== 1
          || providerSigner.id !== guard.user.id
          || providerSigner.email !== guard.user.email
          || providerSigner.role !== guard.user.role
        ) {
          throw new ProviderCountersignError("provider_signer_tenant_changed")
        }
        const countersignedByName =
          providerSigner.name?.trim() || providerSigner.email
        // The executed artifact was rendered with a name read before this lock.
        // If the representative was renamed in between, the document would say
        // one thing and the audit record another — refuse instead.
        if (countersignedByName !== executed.countersignedByName) {
          throw new ProviderCountersignError("provider_signer_tenant_changed")
        }
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
        })
        if (!locked.ok) throw new ProviderCountersignError(locked.reason)
        const current = locked.application
        if (
          current.updatedAt.toISOString() !== application.updatedAt.toISOString()
          || current.status !== "APPROVED"
          || !current.agreementGeneratedAt
          || !current.agreementDocumentId
          || !current.agreementDocumentSha256
          || !current.agreementSignedAt
          || !current.agreementSignatureData?.trim()
          || (current.agreementSignedMethod !== "portal"
            && current.agreementSignedMethod !== "branch")
          || (
            current.agreementSignedMethod === "branch"
            && !current.agreementSignedByUserId?.trim()
          )
          || current.agreementCountersignedAt
        ) {
          throw new ProviderCountersignError("application_changed")
        }
        if (
          current.agreementDocumentId !== application.agreementDocumentId
          || current.agreementDocumentSha256 !== application.agreementDocumentSha256
          || current.agreementSignedAt.toISOString() !== expectedAgreementSignedAt.toISOString()
          || current.agreementSignedMethod !== application.agreementSignedMethod
          || current.agreementSignedByUserId !== application.agreementSignedByUserId
          || current.agreementSignatureData !== application.agreementSignatureData
        ) {
          throw new ProviderCountersignError("agreement_changed")
        }

        const creditLife = verifyStoredCreditLifeDisclosure(current, {
          principalCents: current.appliedAmount,
          termDays: current.appliedTermDays,
        })
        if (!creditLife.ok) throw new ProviderCountersignError("pasq_changed")
        const pasq = verifyStoredPasqBinding(current, {
          tenantId: current.tenantId,
          applicationId: current.id,
          clientId: current.clientId,
          productId: current.productId,
          calculatorPricingFingerprint: locked.approval.calculator.pricingFingerprint,
          creditLifeDisclosureSha256: creditLife.evidence.disclosureSha256,
          requireApprovalBinding: true,
        })
        if (!pasq.ok) throw new ProviderCountersignError("pasq_changed")
        const pasqArtifact = await verifyPasqDocumentArtifact(tx, {
          tenantId: tenant.id,
          clientId: current.clientId,
          documentId: pasq.documentId,
          documentSha256: pasq.documentSha256,
          lock: true,
        })
        if (!pasqArtifact.ok) throw new ProviderCountersignError("pasq_document_changed")

        const contract = readAffordabilitySnapshotStore(current.affordabilityResult).contract
        if (
          !contract
          || !affordabilityContractEvidenceIsIntact(contract, locked.approval)
          || contract.establishedAt !== current.agreementGeneratedAt.toISOString()
          || !affordabilityContractCanBeDisbursed(
            contract, countersignedAt, current.repaymentMethod,
          )
        ) {
          throw new ProviderCountersignError("contract_changed")
        }

        const agreementRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "ClientDocument"
          WHERE "id" = ${current.agreementDocumentId}
            AND "tenantId" = ${tenant.id}
            AND "clientId" = ${current.clientId}
            AND "docType" = 'CREDIT_AGREEMENT'::"DocType"
            AND "fileName" = ${`credit-agreement-${id}.pdf`}
            AND "deletedAt" IS NULL
            AND "verified" = true
            AND "verifiedAt" = ${current.agreementSignedAt}
            AND "signatureState" = 'signed'
            AND "signedAt" = ${current.agreementSignedAt}
            AND "contentSha256" = ${current.agreementDocumentSha256}
            AND "storagePath" IS NOT NULL
          FOR SHARE
        `)
        if (agreementRows[0]?.id !== current.agreementDocumentId) {
          throw new ProviderCountersignError("agreement_document_changed")
        }
        const agreementDocument = await tx.clientDocument.findFirst({
          where: {
            id: current.agreementDocumentId,
            tenantId: tenant.id,
            clientId: current.clientId,
            docType: "CREDIT_AGREEMENT",
            fileName: `credit-agreement-${id}.pdf`,
            deletedAt: null,
            verified: true,
            verifiedAt: current.agreementSignedAt,
            signatureState: "signed",
            signedAt: current.agreementSignedAt,
            contentSha256: current.agreementDocumentSha256,
            storagePath: { not: null },
          },
          select: { id: true, storagePath: true, contentSha256: true },
        })
        if (!agreementDocument?.storagePath) {
          throw new ProviderCountersignError("agreement_document_changed")
        }
        let agreementBytes: Buffer
        try {
          agreementBytes = await readFile(agreementDocument.storagePath)
        } catch {
          throw new ProviderCountersignError("agreement_document_bytes")
        }
        if (!documentBytesMatchSha256(agreementBytes, current.agreementDocumentSha256)) {
          throw new ProviderCountersignError("agreement_document_bytes")
        }
        const artifactRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
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
            AND "data" ->> 'documentId' = ${current.agreementDocumentId}
            AND "data" ->> 'documentSha256' = ${current.agreementDocumentSha256}
          ORDER BY "id"
          FOR SHARE
        `)
        if (artifactRows.length !== 1) {
          throw new ProviderCountersignError("agreement_artifact_changed")
        }
        // Pin the artifact record that supplied the signature anchors. Without
        // this the stamp could have been positioned from one record while a
        // different one is the live evidence.
        if (artifactRows[0].id !== executed.artifactRecordId) {
          throw new ProviderCountersignError("agreement_artifact_changed")
        }

        const consumerSignatureSha256 = providerCountersignatureSha256(
          current.agreementSignatureData,
        )
        const envelopeSha256 = providerCountersignatureEnvelopeSha256({
          tenantId: current.tenantId,
          applicationId: current.id,
          clientId: current.clientId,
          documentSha256: current.agreementDocumentSha256,
          consumerSignedAt: current.agreementSignedAt,
          consumerSignedMethod: current.agreementSignedMethod,
          consumerSignerId: current.agreementSignedMethod === "portal"
            ? current.clientId
            : current.agreementSignedByUserId!,
          consumerSignatureSha256,
          providerCountersignedAt: countersignedAt,
          providerSignerId: providerSigner.id,
          providerSignerName: countersignedByName,
          providerSignerEmail: providerSigner.email,
          providerSignatureSha256: signatureSha256,
        })
        const changed = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            updatedAt: current.updatedAt,
            agreementDocumentId: current.agreementDocumentId,
            agreementDocumentSha256: current.agreementDocumentSha256,
            agreementSignedAt: current.agreementSignedAt,
            agreementSignedMethod: current.agreementSignedMethod,
            agreementSignedByUserId: current.agreementSignedByUserId,
            agreementSignatureData: current.agreementSignatureData,
            agreementCountersignedAt: null,
            // A second countersignature must not mint a second artifact. The
            // predicate, not a prior read, is what makes this exclusive.
            agreementExecutedDocumentId: null,
          },
          data: {
            agreementCountersignedAt: countersignedAt,
            agreementCountersignedById: providerSigner.id,
            agreementCountersignedByName: countersignedByName,
            agreementCountersignedByEmail: providerSigner.email,
            agreementCountersignatureData: signature,
            agreementCountersignatureSha256: signatureSha256,
            agreementCountersignatureEnvelopeSha256: envelopeSha256,
            agreementCountersignedDocumentSha256: current.agreementDocumentSha256,
            // The artifact that actually carries both signatures. Bound in the
            // SAME statement as the countersignature, so a countersigned
            // application without an executed agreement cannot exist.
            agreementExecutedDocumentId: executed.documentId,
            agreementExecutedDocumentSha256: executed.sha256,
          },
        })
        if (changed.count !== 1) throw new ProviderCountersignError("application_changed")

        await tx.clientDocument.create({
          data: {
            id: executed.documentId,
            tenantId: tenant.id,
            clientId: current.clientId,
            docType: "EXECUTED_CREDIT_AGREEMENT",
            fileUrl: `/api/documents/${executed.documentId}/view`,
            fileName: `credit-agreement-executed-${id}.pdf`,
            storagePath: executed.storagePath,
            fileSize: executed.fileSize,
            mimeType: "application/pdf",
            contentSha256: executed.sha256,
            uploadedByType: "staff",
            uploadedById: providerSigner.id,
            extractionStatus: "skipped",
            verified: true,
            verifiedAt: countersignedAt,
            verifiedById: providerSigner.id,
            signatureState: "signed",
            signedAt: countersignedAt,
          },
        })

        const providerEvidence = {
          ...current,
          agreementCountersignedAt: countersignedAt,
          agreementCountersignedById: providerSigner.id,
          agreementCountersignedByName: countersignedByName,
          agreementCountersignedByEmail: providerSigner.email,
          agreementCountersignatureData: signature,
          agreementCountersignatureSha256: signatureSha256,
          agreementCountersignatureEnvelopeSha256: envelopeSha256,
          agreementCountersignedDocumentSha256: current.agreementDocumentSha256,
        }
        if (!verifyStoredProviderCountersign(providerEvidence).ok) {
          throw new ProviderCountersignError("countersign_evidence_invalid")
        }

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: providerSigner.id,
            userEmail: providerSigner.email,
            action: AuditAction.AGREEMENT_PROVIDER_COUNTERSIGNED,
            entity: "LoanApplication",
            entityId: id,
            oldValue: {
              agreementCountersignedAt: null,
            },
            newValue: {
              agreementCountersignedAt: countersignedAt.toISOString(),
              agreementCountersignedById: providerSigner.id,
              agreementCountersignedByName: countersignedByName,
              agreementCountersignedByEmail: providerSigner.email,
              documentId: current.agreementDocumentId,
              documentSha256: current.agreementDocumentSha256,
              executedDocumentId: executed.documentId,
              executedDocumentSha256: executed.sha256,
              // The lender's setting this countersignature was made under.
              segregationOfDuties,
              // "stamped" onto the original signature rules, or "execution_page"
              // appended because this agreement predates recorded anchors.
              // Recorded rather than inferred: the two produce visibly
              // different documents.
              executedArtifactMethod: executed.method,
              // A "stamped" artifact whose consumer signature could not be
              // drawn still looks authoritative. Say so here rather than
              // leaving it discoverable only by opening the PDF.
              executedConsumerSignatureRendered: executed.consumerSignatureRendered,
              executedProviderSignatureRendered: executed.providerSignatureRendered,
              consumerSignedMethod: current.agreementSignedMethod,
              consumerSignerId: current.agreementSignedMethod === "portal"
                ? current.clientId
                : current.agreementSignedByUserId,
              consumerSignatureSha256,
              signatureSha256,
              envelopeSha256,
              contractFingerprint: contract.fingerprint,
              pasqDocumentSha256: pasq.documentSha256,
              pasqEvidenceSha256: pasq.evidence.evidenceSha256,
            },
            ipAddress,
          },
        })
        return {
          countersignedAt,
          countersignedByName,
          documentSha256: current.agreementDocumentSha256,
          envelopeSha256,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      return NextResponse.json(countersigned)
    } catch (error) {
      // A transaction exception can be a lost COMMIT acknowledgement. Resolve
      // the durable state BEFORE deleting anything: discarding the bytes of a
      // countersignature that DID commit would leave a signed loan bound to an
      // executed agreement that no longer exists on disk.
      let committed
      try {
        committed = await prisma.loanApplication.findFirst({
          where: {
            id,
            tenantId: tenant.id,
            agreementExecutedDocumentId: executed.documentId,
            agreementExecutedDocumentSha256: executed.sha256,
            agreementCountersignedAt: { not: null },
          },
          select: {
            agreementCountersignedAt: true,
            agreementCountersignedByName: true,
            agreementDocumentSha256: true,
            agreementCountersignatureEnvelopeSha256: true,
          },
        })
      } catch {
        return NextResponse.json(
          {
            error: "The countersignature outcome could not be resolved; the staged executed agreement requires reconciliation.",
            countersignEvidence: "commit_outcome_unknown",
          },
          { status: 503 },
        )
      }
      if (committed?.agreementCountersignedAt) {
        return NextResponse.json({
          countersignedAt: committed.agreementCountersignedAt,
          countersignedByName: committed.agreementCountersignedByName,
          documentSha256: committed.agreementDocumentSha256,
          envelopeSha256: committed.agreementCountersignatureEnvelopeSha256,
        })
      }

      const discarded = await discardExecutedBytes()
      if (error instanceof ProviderCountersignError) {
        const artifactFailure = error.reason.startsWith("agreement_document")
          || error.reason.startsWith("executed_artifact")
          || error.reason === "agreement_artifact_changed"
          || error.reason === "pasq_document_changed"
        return NextResponse.json(
          {
            error: artifactFailure
              ? "The exact PASQ or signed agreement artifact changed; return the application to review and generate a new agreement."
              : "The application or approval evidence changed before countersigning; refresh and retry or return it to review.",
            countersignEvidence: error.reason,
            ...(discarded ? {} : { executedArtifact: "reconciliation_required" }),
          },
          { status: artifactFailure ? 422 : 409 },
        )
      }
      // A database guard refused the write (a trigger or CHECK). Its sentence
      // names the rule; a bare 500 left the button with nothing to show.
      const guardRefusal = databaseGuardRefusal(error)
      if (guardRefusal) {
        return NextResponse.json(
          {
            error: `The countersignature was refused: ${guardRefusal}.`,
            countersignEvidence: "database_guard_refused",
            ...(discarded ? {} : { executedArtifact: "reconciliation_required" }),
          },
          { status: 409 },
        )
      }
      throw error
    }
  })
}
