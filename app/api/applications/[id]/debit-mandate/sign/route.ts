import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { verifyLockedCurrentAffordabilityApproval } from "@/lib/affordability/current-approval"
import {
  debitMandateApplicationArgs,
  renderApplicationDebitMandatePdf,
  verifyCurrentStoredDebitMandate,
} from "@/lib/compliance/debit-mandate.server"
import { sha256DebitMandateValue } from "@/lib/compliance/debit-mandate"
import {
  documentBytesMatchSha256,
  isSha256Digest,
  sha256DocumentBytes,
} from "@/lib/documents/content-integrity"
import {
  deleteManagedFileStrict,
  managedStoragePath,
  saveFileToManagedPath,
} from "@/lib/storage"
import { DebitMandateConfigurationError } from "@/lib/config/debit-mandate"
import { LenderIdentityError } from "@/lib/config/identity"
import { hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

const DEBIT_MANDATE_ARTIFACT_KIND = "DEBIT_MANDATE_ARTIFACT"
const DEBIT_MANDATE_STAGING_LEASE_MS = 15 * 60 * 1000

interface DebitMandateArtifactManifest {
  kind: typeof DEBIT_MANDATE_ARTIFACT_KIND
  lifecycle: "STAGING" | "RECONCILING" | "COMPLETED" | "FAILED"
  applicationId: string
  clientId: string
  documentId: string
  documentSha256: string
  storagePath: string
  fileSize: number
  signedAt: string
  signatureSha256: string
  evidenceSha256: string
  stagedAt: string
  completedAt?: string
  failedAt?: string
  failureReason?: string
}

function debitMandateArtifactKey(tenantId: string, applicationId: string) {
  return `debit-mandate-artifact:${tenantId}:${applicationId}`
}

function readDebitMandateArtifactManifest(
  value: unknown,
): DebitMandateArtifactManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const manifest = value as Partial<DebitMandateArtifactManifest>
  if (
    manifest.kind !== DEBIT_MANDATE_ARTIFACT_KIND
    || !["STAGING", "RECONCILING", "COMPLETED", "FAILED"].includes(
      manifest.lifecycle ?? "",
    )
    || typeof manifest.applicationId !== "string"
    || typeof manifest.clientId !== "string"
    || typeof manifest.documentId !== "string"
    || !isSha256Digest(manifest.documentSha256)
    || typeof manifest.storagePath !== "string"
    || !Number.isSafeInteger(manifest.fileSize)
    || typeof manifest.signedAt !== "string"
    || !Number.isFinite(Date.parse(manifest.signedAt))
    || !isSha256Digest(manifest.signatureSha256)
    || !isSha256Digest(manifest.evidenceSha256)
    || typeof manifest.stagedAt !== "string"
    || !Number.isFinite(Date.parse(manifest.stagedAt))
  ) {
    return null
  }
  return manifest as DebitMandateArtifactManifest
}

async function markDebitMandateArtifactFailed(args: {
  tenantId: string
  applicationId: string
  stagingId: string
  idempotencyKey: string
  manifest: DebitMandateArtifactManifest
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
          userId: null,
          userEmail: args.userEmail,
          action: AuditAction.DEBIT_MANDATE_ARTIFACT_STAGING_FAILED,
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
            bytesDeleted: true,
            reason: args.reason,
          },
        },
      })
      return true
    })
  } catch {
    return false
  }
}

class DebitMandateSigningError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message)
    this.name = "DebitMandateSigningError"
  }
}

function signatureFromBody(
  body: unknown,
  clientName: string,
): { signature: string; draftDocumentSha256: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DebitMandateSigningError(400, "invalid_body", "Invalid request body.")
  }
  const value = body as Record<string, unknown>
  if (
    typeof value.draftDocumentSha256 !== "string"
    || !isSha256Digest(value.draftDocumentSha256)
  ) {
    throw new DebitMandateSigningError(
      400,
      "draft_hash_missing",
      "The exact prepared mandate hash is required.",
    )
  }
  if (typeof value.signature !== "string") {
    throw new DebitMandateSigningError(
      422,
      "signature_missing",
      "A signature is required.",
    )
  }
  const signature = value.signature.trim()
  if (!signature || signature.length > 500_000) {
    throw new DebitMandateSigningError(
      signature.length > 500_000 ? 413 : 422,
      "signature_invalid",
      signature.length > 500_000
        ? "The signature artefact is too large."
        : "A signature is required.",
    )
  }
  if (signature.startsWith("data:image/png;base64,")) {
    const encoded = signature.slice("data:image/png;base64,".length)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new DebitMandateSigningError(
        422,
        "signature_invalid",
        "The drawn signature is not a valid PNG.",
      )
    }
    const bytes = Buffer.from(encoded, "base64")
    if (
      bytes.length < 32
      || bytes.length > 375_000
      || !bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw new DebitMandateSigningError(
        422,
        "signature_invalid",
        "The drawn signature is not a valid PNG.",
      )
    }
  } else {
    const normalise = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-ZA")
    if (
      signature.length < 3
      || signature.length > 120
      || /[\u0000-\u001f\u007f]/.test(signature)
      || normalise(signature) !== normalise(clientName)
    ) {
      throw new DebitMandateSigningError(
        422,
        "signature_invalid",
        "Type the account holder's full name exactly as shown, or draw a signature.",
      )
    }
  }
  return {
    signature,
    draftDocumentSha256: value.draftDocumentSha256,
  }
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const session = await auth()
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (session.user.role !== "CLIENT") {
    return NextResponse.json(
      { error: "The account holder must sign the debit mandate in the customer portal." },
      { status: 403 },
    )
  }

  const { id } = await params
  let storagePath: string | null = null
  let documentId: string | null = null
  let documentSha256: string | null = null
  let signedAt: Date | null = null
  let signingTenantId: string | null = null
  let stagingId: string | null = null
  let artifactIdempotencyKey: string | null = null
  let artifactManifest: DebitMandateArtifactManifest | null = null

  try {
    return await withTenantContext(req, async (tenant) => {
      signingTenantId = tenant.id
      const application = await prisma.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        ...debitMandateApplicationArgs,
      })
      if (
        !application
        || application.clientId !== session.user.id
        || !hasClientBorrower(application)
      ) {
        throw new DebitMandateSigningError(404, "not_found", "Application not found.")
      }
      if (application.repaymentMethod !== "DEBIT_ORDER") {
        throw new DebitMandateSigningError(
          409,
          "repayment_method_eft",
          "This application is approved for EFT repayment and does not require a debit mandate.",
        )
      }
      artifactIdempotencyKey = debitMandateArtifactKey(tenant.id, id)
      const outstandingArtifact = await prisma.complianceRecord.findUnique({
        where: { idempotencyKey: artifactIdempotencyKey },
        select: {
          id: true,
          tenantId: true,
          status: true,
          dueDate: true,
          data: true,
        },
      })
      if (outstandingArtifact) {
        const manifest = readDebitMandateArtifactManifest(outstandingArtifact.data)
        if (
          outstandingArtifact.tenantId !== tenant.id
          || outstandingArtifact.status !== "PENDING"
          || !manifest
          || manifest.applicationId !== id
          || manifest.clientId !== application.clientId
          || (manifest.lifecycle !== "STAGING"
            && manifest.lifecycle !== "RECONCILING")
        ) {
          throw new DebitMandateSigningError(
            503,
            "staging_reconciliation_required",
            "The previous debit-mandate signing attempt requires reconciliation.",
          )
        }
        let reconcilingManifest = manifest
        if (manifest.lifecycle === "STAGING") {
          if (
            outstandingArtifact.dueDate instanceof Date
            && outstandingArtifact.dueDate.getTime() > Date.now()
          ) {
            throw new DebitMandateSigningError(
              409,
              "staging_in_progress",
              "Debit-mandate signing is already in progress.",
            )
          }
          reconcilingManifest = { ...manifest, lifecycle: "RECONCILING" }
          const claimed = await prisma.$transaction(async (tx) => {
            const changed = await tx.complianceRecord.updateMany({
              where: {
                id: outstandingArtifact.id,
                tenantId: tenant.id,
                idempotencyKey: artifactIdempotencyKey!,
                status: "PENDING",
                dueDate: { lte: new Date() },
                data: { path: ["lifecycle"], equals: "STAGING" },
              },
              data: {
                data: reconcilingManifest as unknown as Prisma.InputJsonValue,
              },
            })
            if (changed.count !== 1) return false
            await tx.auditLog.create({
              data: {
                tenantId: tenant.id,
                userId: null,
                userEmail: session.user.email,
                action: AuditAction.DEBIT_MANDATE_ARTIFACT_STAGING_RECOVERY_STARTED,
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
            throw new DebitMandateSigningError(
              503,
              "staging_reconciliation_required",
              "The previous debit-mandate artifact changed during recovery.",
            )
          }
        }
        const recovered = await markDebitMandateArtifactFailed({
          tenantId: tenant.id,
          applicationId: id,
          stagingId: outstandingArtifact.id,
          idempotencyKey: artifactIdempotencyKey,
          manifest: reconcilingManifest,
          userEmail: session.user.email,
          reason: "Recovered an expired debit-mandate artifact staging lease before retry.",
          expectedLifecycle: "RECONCILING",
        })
        if (!recovered) {
          throw new DebitMandateSigningError(
            503,
            "staging_reconciliation_required",
            "The expired debit-mandate artifact could not be reconciled safely.",
          )
        }
      }
      if (application.status !== "APPROVED" || !application.agreementSignedAt) {
        throw new DebitMandateSigningError(
          409,
          "agreement_not_signed",
          "Sign the approved credit agreement before signing the debit mandate.",
        )
      }
      if (application.debitMandateSignedAt) {
        throw new DebitMandateSigningError(
          409,
          "already_signed",
          "The debit mandate is already signed.",
        )
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        throw new DebitMandateSigningError(
          400,
          "invalid_body",
          "Invalid request body.",
        )
      }
      const parsed = signatureFromBody(
        body,
        `${application.client.firstName} ${application.client.lastName}`,
      )
      const preparation = await verifyCurrentStoredDebitMandate(
        prisma as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
        { tenantId: tenant.id, application, requireSignature: false },
      )
      if (!preparation.ok) {
        throw new DebitMandateSigningError(
          422,
          preparation.reason,
          "The prepared debit mandate no longer matches the current banking, bank-statement, or repayment evidence.",
        )
      }
      if (parsed.draftDocumentSha256 !== preparation.draftDocumentSha256) {
        throw new DebitMandateSigningError(
          409,
          "draft_hash_changed",
          "The mandate shown for signature is no longer current. Refresh and review it again.",
        )
      }
      const tenantInfo = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { id: true },
      })
      if (!tenantInfo) {
        throw new DebitMandateSigningError(
          503,
          "tenant_configuration",
          "Tenant configuration is unavailable.",
        )
      }
      const pdfTenant = {
        id: tenantInfo.id,
      }
      const exactDraft = await renderApplicationDebitMandatePdf({
        tenant: pdfTenant,
        application,
        collectionReference: preparation.evidence.collectionReference,
        bankDetails: preparation.bankDetails,
        paymentTerms: preparation.contract.paymentTerms,
        generatedAt: application.debitMandatePreparedAt!,
      })
      if (!documentBytesMatchSha256(exactDraft, preparation.draftDocumentSha256)) {
        throw new DebitMandateSigningError(
          422,
          "draft_bytes_changed",
          "The exact prepared mandate bytes failed their integrity check.",
        )
      }

      signedAt = new Date()
      const signatureSha256 = sha256DebitMandateValue(parsed.signature)
      let signedPdf: Buffer
      try {
        signedPdf = await renderApplicationDebitMandatePdf({
          tenant: pdfTenant,
          application,
          collectionReference: preparation.evidence.collectionReference,
          bankDetails: preparation.bankDetails,
          paymentTerms: preparation.contract.paymentTerms,
          generatedAt: application.debitMandatePreparedAt!,
          authorization: {
            signedAt,
            method: "portal",
            signature: parsed.signature,
            signatureSha256,
            evidenceSha256: preparation.evidenceSha256,
            sourceDocumentSha256: preparation.draftDocumentSha256,
          },
        })
      } catch (error) {
        if (parsed.signature.startsWith("data:image/png;base64,")) {
          throw new DebitMandateSigningError(
            422,
            "signature_invalid",
            "The drawn signature is not a readable PNG.",
          )
        }
        throw error
      }
      documentId = randomUUID()
      documentSha256 = sha256DocumentBytes(signedPdf)
      storagePath = managedStoragePath(
        `debit-mandate-${documentId}`,
        "application/pdf",
      )
      const stagedAt = new Date()
      artifactManifest = {
        kind: DEBIT_MANDATE_ARTIFACT_KIND,
        lifecycle: "STAGING",
        applicationId: id,
        clientId: application.clientId,
        documentId,
        documentSha256,
        storagePath,
        fileSize: signedPdf.length,
        signedAt: signedAt.toISOString(),
        signatureSha256,
        evidenceSha256: preparation.evidenceSha256,
        stagedAt: stagedAt.toISOString(),
      }
      stagingId = await prisma.$transaction(async (tx) => {
        const staged = await tx.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            type: "DEBIT_MANDATE_ARTIFACT",
            referenceId: id,
            idempotencyKey: artifactIdempotencyKey,
            status: "PENDING",
            dueDate: new Date(
              stagedAt.getTime() + DEBIT_MANDATE_STAGING_LEASE_MS,
            ),
            data: artifactManifest as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: null,
            userEmail: session.user.email,
            action: AuditAction.DEBIT_MANDATE_ARTIFACT_STAGED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              stagingId: staged.id,
              lifecycle: "STAGING",
              documentId,
              documentSha256,
              expectedFileSize: signedPdf.length,
              evidenceSha256: preparation.evidenceSha256,
            },
          },
        })
        return staged.id
      })
      const stored = await saveFileToManagedPath(
        signedPdf,
        "application/pdf",
        `debit-mandate-${documentId}`,
      )
      if (
        stored.storagePath !== storagePath
        || stored.fileSize !== artifactManifest.fileSize
      ) {
        throw new Error("Managed storage returned unexpected debit-mandate metadata")
      }
      const ip = recordedCallerIp(req)

      const result = await prisma.$transaction(async (tx) => {
        const locked = await verifyLockedCurrentAffordabilityApproval(tx, {
          tenantId: tenant.id,
          applicationId: id,
        })
        if (!locked.ok) {
          throw new DebitMandateSigningError(
            409,
            locked.reason,
            "The approved evidence changed while the mandate was being signed.",
          )
        }
        const current = await tx.loanApplication.findUnique({
          where: { id, tenantId: tenant.id },
          ...debitMandateApplicationArgs,
        })
        if (
          !current
          || current.clientId !== session.user.id
          || !hasClientBorrower(current)
          || current.status !== "APPROVED"
          || current.repaymentMethod !== "DEBIT_ORDER"
          || !current.agreementSignedAt
          || current.debitMandateSignedAt
        ) {
          throw new DebitMandateSigningError(
            409,
            "application_changed",
            "The application changed while the mandate was being signed.",
          )
        }
        const currentPreparation = await verifyCurrentStoredDebitMandate(
          tx as unknown as Parameters<typeof verifyCurrentStoredDebitMandate>[0],
          { tenantId: tenant.id, application: current, requireSignature: false },
        )
        if (
          !currentPreparation.ok
          || currentPreparation.draftDocumentSha256 !== preparation.draftDocumentSha256
          || currentPreparation.evidenceSha256 !== preparation.evidenceSha256
        ) {
          throw new DebitMandateSigningError(
            409,
            "mandate_changed",
            "The banking or mandate evidence changed while it was being signed.",
          )
        }
        const created = await tx.clientDocument.create({
          data: {
            id: documentId!,
            tenantId: tenant.id,
            clientId: current.clientId,
            docType: "DEBIT_MANDATE",
            fileUrl: `/api/applications/${id}/debit-mandate`,
            fileName: `debit-mandate-${id}.pdf`,
            storagePath: storagePath!,
            fileSize: stored.fileSize,
            mimeType: "application/pdf",
            contentSha256: documentSha256!,
            uploadedByType: "client",
            uploadedById: current.clientId,
            extractionStatus: "skipped",
            verified: true,
            verifiedAt: signedAt!,
            signatureState: "signed",
            signatureRequestedAt: current.debitMandatePreparedAt,
            signedAt: signedAt!,
            signedByIp: ip,
          },
          select: { id: true },
        })
        const changed = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            status: "APPROVED",
            repaymentMethod: "DEBIT_ORDER",
            updatedAt: current.updatedAt,
            agreementSignedAt: current.agreementSignedAt,
            debitMandatePreparedAt: current.debitMandatePreparedAt,
            debitMandateDraftSha256: currentPreparation.draftDocumentSha256,
            debitMandateEvidenceSha256: currentPreparation.evidenceSha256,
            debitMandateSignedAt: null,
          },
          data: {
            debitMandateSignedAt: signedAt!,
            debitMandateSignedMethod: "portal",
            debitMandateSignedByIp: ip,
            debitMandateSignatureData: parsed.signature,
            debitMandateSignatureSha256: signatureSha256,
            debitMandateDocumentId: created.id,
            debitMandateDocumentSha256: documentSha256!,
          },
        })
        if (changed.count !== 1) {
          throw new DebitMandateSigningError(
            409,
            "application_changed",
            "The application changed while the mandate was being signed.",
          )
        }
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: null,
            userEmail: session.user.email,
            action: AuditAction.DEBIT_MANDATE_SIGNED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              signedAt: signedAt!.toISOString(),
              method: "portal",
              documentId: created.id,
              documentSha256,
              draftDocumentSha256: currentPreparation.draftDocumentSha256,
              evidenceSha256: currentPreparation.evidenceSha256,
              signatureSha256,
              bankDetailsSha256: currentPreparation.evidence.bankDetailsSha256,
              bankStatementDocumentId:
                currentPreparation.evidence.bankStatement.documentId,
              collectionReference:
                currentPreparation.evidence.collectionReference,
            },
            ipAddress: ip,
          },
        })
        await tx.documentAccessLog.create({
          data: {
            documentId: created.id,
            accessorType: "client",
            accessorId: current.clientId,
            action: "signed",
            ipAddress: ip,
            userAgent: req.headers.get("user-agent") ?? null,
          },
        })
        const completedAt = new Date()
        const completed = await tx.complianceRecord.updateMany({
          where: {
            id: stagingId!,
            tenantId: tenant.id,
            idempotencyKey: artifactIdempotencyKey!,
            status: "PENDING",
            data: { path: ["lifecycle"], equals: "STAGING" },
          },
          data: {
            idempotencyKey: null,
            status: "COMPLETED",
            completedAt,
            data: {
              ...artifactManifest!,
              lifecycle: "COMPLETED",
              completedAt: completedAt.toISOString(),
            } as Prisma.InputJsonValue,
          },
        })
        if (completed.count !== 1) {
          throw new Error("Debit-mandate artifact staging record changed before finalization")
        }
        return {
          signedAt: signedAt!,
          documentId: created.id,
          documentSha256,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

      return NextResponse.json(result)
    })
  } catch (error) {
    if (
      storagePath
      && documentId
      && documentSha256
      && signingTenantId
      && signedAt
      && stagingId
      && artifactIdempotencyKey
      && artifactManifest
    ) {
      let committed
      try {
        committed = await prisma.loanApplication.findFirst({
          where: {
            id,
            tenantId: signingTenantId,
            debitMandateDocumentId: documentId,
            debitMandateDocumentSha256: documentSha256,
            debitMandateSignedAt: signedAt,
          },
          select: { id: true, debitMandateSignedAt: true },
        })
      } catch (reconciliationError) {
        console.error(
          "[debit-mandate/sign] commit reconciliation failed:",
          reconciliationError,
        )
        return NextResponse.json(
          {
            error: "The signing outcome could not be reconciled safely. The indexed artifact has been retained for recovery.",
            debitMandate: "commit_reconciliation_required",
          },
          { status: 503 },
        )
      }
      if (committed) {
        return NextResponse.json({
          signedAt: committed.debitMandateSignedAt,
          documentId,
          documentSha256,
          reconciled: true,
        })
      }
      const cleaned = await markDebitMandateArtifactFailed({
        tenantId: signingTenantId,
        applicationId: id,
        stagingId,
        idempotencyKey: artifactIdempotencyKey,
        manifest: artifactManifest,
        userEmail: session.user.email,
        reason: `Debit-mandate signing failed before commit: ${
          error instanceof Error ? error.message : String(error)
        }`,
        expectedLifecycle: "STAGING",
      })
      if (!cleaned) {
        return NextResponse.json(
          {
            error: "The failed signing artifact requires storage reconciliation.",
            debitMandate: "staging_reconciliation_required",
          },
          { status: 503 },
        )
      }
    }
    if (error instanceof DebitMandateSigningError) {
      return NextResponse.json(
        { error: error.message, debitMandate: error.reason },
        { status: error.status },
      )
    }
    if (error instanceof DebitMandateConfigurationError || error instanceof LenderIdentityError) {
      return NextResponse.json(
        { error: error.message, debitMandate: "configuration" },
        { status: 503 },
      )
    }
    console.error("[debit-mandate/sign] failed:", error)
    return NextResponse.json(
      { error: "Failed to sign debit mandate." },
      { status: 500 },
    )
  }
}
