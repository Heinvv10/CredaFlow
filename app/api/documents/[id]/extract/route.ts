import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { readStatementInBackground } from "@/lib/statement-analysis/persist"
import { recomputeClientApplications } from "@/lib/credit-checks/recompute"
import { hasMinRole } from "@/lib/permissions"
import { extractDocumentData } from "@/lib/vlm-extract"
import { validateDocumentAgainstClient } from "@/lib/ocr/documentValidationService"
import { getDocumentCaller } from "@/lib/document-auth"
import { withTenantContext } from "@/lib/tenant"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { isLockedStatutoryEvidence } from "@/lib/documents/generic-action-policy"

interface RouteParams {
  params: Promise<{ id: string }>
}

// `pending` is retained for recovery of documents uploaded by older builds.
// New uploads claim a generation and start in `processing` atomically.
const REEXTRACTABLE_STATUSES = new Set(["pending", "done", "failed", "skipped", "completed"])
const EXTRACTION_LEASE_MS = 15 * 60 * 1000

interface ExtractionAttempt {
  documentId: string
  tenantId: string
  clientId: string
  generation: string
}

interface LockedDocument {
  id: string
  clientId: string
  storagePath: string | null
  mimeType: string | null
  docType: string
  extractionStatus: string
  extractionGeneration: string | null
  extractionStartedAt: Date | null
  client: { popiaConsentGiven: boolean }
}

async function failCurrentAttempt(
  attempt: ExtractionAttempt,
  error: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAffordabilityClientEvidence(tx, {
      tenantId: attempt.tenantId,
      clientId: attempt.clientId,
    })

    const failed = await tx.clientDocument.updateMany({
      where: {
        id: attempt.documentId,
        tenantId: attempt.tenantId,
        clientId: attempt.clientId,
        deletedAt: null,
        extractionStatus: "processing",
        extractionGeneration: attempt.generation,
      },
      data: {
        extractionStatus: "failed",
        extractionStartedAt: null,
        extractionError: error,
      },
    } as never)
    return failed.count === 1
  })
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id } = await params
  const caller = await getDocumentCaller()
  if (!caller || caller.type !== "staff") {
    return NextResponse.json({ error: "Staff only" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    let attempt: ExtractionAttempt | null = null

    try {
      // This first read only discovers the immutable client lock scope. All
      // extraction state, consent, and storage fields are re-read after the
      // client-scoped advisory lock is held.
      const documentScope = await prisma.clientDocument.findFirst({
        where: { id, tenantId: tenant.id },
        select: { clientId: true },
      })
      if (!documentScope) {
        return NextResponse.json({ error: "Document not found" }, { status: 404 })
      }

      const generation = randomUUID()
      const startedAt = new Date()
      const start = await prisma.$transaction(async (tx) => {
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId: documentScope.clientId,
        })

        const doc = await tx.clientDocument.findFirst({
          where: {
            id,
            tenantId: tenant.id,
            clientId: documentScope.clientId,
            deletedAt: null,
          },
          include: {
            client: { select: { popiaConsentGiven: true } },
          },
        } as never) as unknown as LockedDocument | null

        if (!doc) {
          return { ok: false as const, status: 404, error: "Document not found" }
        }
        if (isLockedStatutoryEvidence(doc.docType)) {
          if (
            doc.docType === "CREDIT_AGREEMENT"
            || doc.docType === "EXECUTED_CREDIT_AGREEMENT"
          ) {
            return {
              ok: false as const,
              status: 409,
              error: "Credit-agreement records are immutable and cannot be re-extracted",
            }
          }
          if (doc.docType === "DEBIT_MANDATE") {
            return {
              ok: false as const,
              status: 409,
              error: "Signed debit-mandate records are immutable and cannot be re-extracted",
            }
          }
          if (doc.docType === "SIGNED_AGREEMENT_PACKET") {
            return {
              ok: false as const,
              status: 409,
              error: "A returned signed packet is immutable and cannot be re-extracted",
            }
          }
          return {
            ok: false as const,
            status: 409,
            error: "Form 20/PASQ is locked statutory evidence; complete it through the signing and acknowledgement workflow",
          }
        }
        if (!doc.storagePath) {
          return { ok: false as const, status: 404, error: "Document not found" }
        }
        if (doc.docType === "SELFIE") {
          return {
            ok: false as const,
            status: 409,
            error: "Selfie biometric evidence can only be refreshed by uploading a new selfie",
          }
        }
        if (!doc.client.popiaConsentGiven) {
          return { ok: false as const, status: 403, error: "POPIA consent not given" }
        }
        const processingLeaseIsActive = doc.extractionStatus === "processing"
          && doc.extractionStartedAt !== null
          && doc.extractionStartedAt.getTime() > startedAt.getTime() - EXTRACTION_LEASE_MS
        const abandonedProcessing = doc.extractionStatus === "processing"
          && !processingLeaseIsActive

        if (!REEXTRACTABLE_STATUSES.has(doc.extractionStatus) && !abandonedProcessing) {
          return {
            ok: false as const,
            status: 409,
            error: doc.extractionStatus === "processing"
              ? "Document extraction is already in progress"
              : "Document is not ready for re-extraction",
          }
        }

        const claimed = await tx.clientDocument.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            clientId: documentScope.clientId,
            deletedAt: null,
            extractionStatus: doc.extractionStatus,
            extractionGeneration: doc.extractionGeneration,
            extractionStartedAt: doc.extractionStartedAt,
          },
          data: {
            extractionStatus: "processing",
            extractionGeneration: generation,
            extractionStartedAt: startedAt,
            extractionResult: Prisma.DbNull,
            extractionError: null,
            validationResult: Prisma.DbNull,
            validationMismatch: false,
            validationScore: null,
          },
        } as never)
        if (claimed.count !== 1) {
          return {
            ok: false as const,
            status: 409,
            error: "Document extraction changed concurrently",
          }
        }

        await tx.documentAccessLog.create({
          data: {
            documentId: doc.id,
            accessorType: "staff",
            accessorId: caller.userId,
            action: "extract",
          },
        })

        return {
          ok: true as const,
          doc: {
            id: doc.id,
            clientId: doc.clientId,
            storagePath: doc.storagePath,
            mimeType: doc.mimeType,
            docType: doc.docType,
          },
        }
      })

      if (!start.ok) {
        return NextResponse.json({ error: start.error }, { status: start.status })
      }

      attempt = {
        documentId: start.doc.id,
        tenantId: tenant.id,
        clientId: start.doc.clientId,
        generation,
      }

      // A manual re-extract also (re)reads a statement for the credit checks:
      // a no-op when these bytes already have a read, except a failed one.
      if (start.doc.docType === "BANK_STATEMENT") {
        const clientId = start.doc.clientId
        readStatementInBackground(tenant.id, start.doc.id, {
          // Discarding a failed read is for credit staff, not every staff role.
          retryFailed: hasMinRole(caller.role, "CREDIT_OFFICER"),
          onRead: () => recomputeClientApplications(tenant.id, clientId),
        })
      }

      const buffer = await readFile(start.doc.storagePath)
      const result = await extractDocumentData({
        fileBuffer: buffer,
        mimeType: start.doc.mimeType || "application/octet-stream",
        docType: start.doc.docType,
      })

      if (!result.ok || !result.data) {
        const error = result.error ?? "Unknown error"
        const failed = await failCurrentAttempt(attempt, error)
        if (!failed) {
          return NextResponse.json(
            { error: "Document extraction was superseded" },
            { status: 409 },
          )
        }
        return NextResponse.json({ ok: false, error }, { status: 422 })
      }
      const extractedData = result.data

      const completion = await prisma.$transaction(async (tx) => {
        await lockAffordabilityClientEvidence(tx, {
          tenantId: tenant.id,
          clientId: start.doc.clientId,
        })

        const current = await tx.clientDocument.findFirst({
          where: {
            id: start.doc.id,
            tenantId: tenant.id,
            clientId: start.doc.clientId,
            deletedAt: null,
            extractionStatus: "processing",
            extractionGeneration: generation,
          },
          select: { id: true },
        } as never)
        if (!current) return { state: "superseded" as const }

        let validationResult: Prisma.InputJsonValue
        let validationMismatch: boolean
        let validationScore: number
        try {
          const validation = await validateDocumentAgainstClient(
            extractedData,
            start.doc.docType,
            start.doc.clientId,
            tx,
          )
          validationResult = validation as unknown as Prisma.InputJsonValue
          validationMismatch = !validation.isValid
          validationScore = validation.matchScore
        } catch (validationError) {
          console.error("Document validation failed:", validationError)
          const validationFailure = `Client validation failed: ${
            validationError instanceof Error ? validationError.message : String(validationError)
          }`
          const failed = await tx.clientDocument.updateMany({
            where: {
              id: start.doc.id,
              tenantId: tenant.id,
              clientId: start.doc.clientId,
              deletedAt: null,
              extractionStatus: "processing",
              extractionGeneration: generation,
            },
            data: {
              extractionStatus: "failed",
              extractionStartedAt: null,
              extractionResult: extractedData as unknown as Prisma.InputJsonValue,
              extractionError: validationFailure,
              validationResult: Prisma.DbNull,
              // No validation decision exists. Treat the evidence as unsafe
              // anywhere that still inspects this legacy boolean in isolation.
              validationMismatch: true,
              validationScore: null,
            },
          } as never)
          return failed.count === 1
            ? { state: "validation_failed" as const, error: validationFailure }
            : { state: "superseded" as const }
        }

        const completed = await tx.clientDocument.updateMany({
          where: {
            id: start.doc.id,
            tenantId: tenant.id,
            clientId: start.doc.clientId,
            deletedAt: null,
            extractionStatus: "processing",
            extractionGeneration: generation,
          },
          data: {
            extractionStatus: "done",
            extractionStartedAt: null,
            extractionResult: extractedData as unknown as Prisma.InputJsonValue,
            extractionError: null,
            validationResult,
            validationMismatch,
            validationScore,
          },
        } as never)
        return completed.count === 1
          ? { state: "done" as const }
          : { state: "superseded" as const }
      })

      if (completion.state === "superseded") {
        return NextResponse.json(
          { error: "Document extraction was superseded" },
          { status: 409 },
        )
      }
      if (completion.state === "validation_failed") {
        return NextResponse.json(
          { ok: false, error: completion.error },
          { status: 422 },
        )
      }
      // A re-extracted payslip feeds the credit checks: raise what it shows now.
      if (start.doc.docType === "PAYSLIP") {
        await recomputeClientApplications(tenant.id, start.doc.clientId).catch((err) => {
          console.error("[document-extract] credit-check recompute failed:", { documentId: start.doc.id, error: err instanceof Error ? err.name : "unknown" })
        })
      }

      return NextResponse.json({ ok: true, data: extractedData })
    } catch (error) {
      console.error("Document extraction failed:", error)
      if (attempt) {
        try {
          await failCurrentAttempt(attempt, String(error))
        } catch (stateError) {
          console.error("Failed to persist extraction failure:", stateError)
        }
      }
      return NextResponse.json(
        { error: "Failed to extract document data" },
        { status: 500 }
      )
    }
  })
}
