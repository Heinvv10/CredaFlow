import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { saveFile } from "@/lib/storage"
import { readStatementInBackground } from "@/lib/statement-analysis/persist"
import { recomputeClientApplications } from "@/lib/credit-checks/recompute"
import { countIncrementalUpdates } from "@/lib/statement-analysis/pdf-tools"
import { extractDocumentData } from "@/lib/vlm-extract"
import { validateDocumentAgainstClient } from "@/lib/ocr/documentValidationService"
import {
  getDocumentCaller,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  VALID_DOC_TYPES,
  matchesMagic,
  MAGIC_BYTE_PREFIX,
} from "@/lib/document-auth"
import { withTenantContext } from "@/lib/tenant"
import type { DocType } from "@prisma/client"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { CORE_KYC_UPLOAD_DOC_TYPES } from "@/lib/document-types"
import {
  clientPdfPasswordCandidates,
  decryptPdfIfEncrypted,
} from "@/lib/documents/pdf-decrypt"

interface UploadExtractionAttempt {
  documentId: string
  tenantId: string
  clientId: string
  generation: string
}

async function failUploadExtraction(
  attempt: UploadExtractionAttempt,
  status: "failed" | "skipped",
  error: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockAffordabilityClientEvidence(tx, {
      tenantId: attempt.tenantId,
      clientId: attempt.clientId,
    })
    await tx.clientDocument.updateMany({
      where: {
        id: attempt.documentId,
        tenantId: attempt.tenantId,
        clientId: attempt.clientId,
        deletedAt: null,
        extractionStatus: "processing",
        extractionGeneration: attempt.generation,
      },
      data: {
        extractionStatus: status,
        extractionStartedAt: null,
        extractionError: error,
      },
    } as never)
  })
}

/**
 * Document types this route exists to collect. Uploading one of these while an
 * agreement is unsigned is ordinary KYC work, not a mis-filed signed contract,
 * so it must not raise the signed-agreement warning below.
 */
// Typed against Prisma's DocType on purpose: as a plain Set<string> this
// silently carried "PROOF_OF_RESIDENCE", which is not an enum member (the real
// one is PROOF_OF_ADDRESS). Nothing failed, because VALID_DOC_TYPES rejects
// unknown values earlier — so the typo was invisible to the compiler and to
// every test. The annotation makes the next one a build error.
const CORE_KYC_DOC_TYPES: ReadonlySet<DocType> = new Set<DocType>(
  CORE_KYC_UPLOAD_DOC_TYPES,
)

function sanitiseDoc(doc: Record<string, unknown>) {
  const { storagePath: _sp, ...safe } = doc
  return safe
}

export async function POST(req: NextRequest) {
  const caller = await getDocumentCaller()
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return withTenantContext(req, async (tenant) => {
    try {
      const formData = await req.formData()
      const file = formData.get("file") as File | null
      const docType = formData.get("docType") as string | null
      const clientIdParam = formData.get("clientId") as string | null

      if (!file || !docType) {
        return NextResponse.json(
          { error: "file and docType are required" },
          { status: 400 }
        )
      }

      if (!VALID_DOC_TYPES.includes(docType as (typeof VALID_DOC_TYPES)[number])) {
        return NextResponse.json({ error: "Invalid docType" }, { status: 400 })
      }

      // SELFIE evidence is only valid after the dedicated route has serialized
      // the attempt and completed both liveness and provider verification.
      // Accepting it here would create an unbound document that can race the
      // payout gate or be mistaken for biometric KYC.
      if (docType === "SELFIE") {
        return NextResponse.json(
          { error: "Selfies must be uploaded through the biometric verification workflow" },
          { status: 409 },
        )
      }

      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return NextResponse.json(
          { error: "File type not allowed. Accepted: JPEG, PNG, WebP, PDF" },
          { status: 400 }
        )
      }

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: "File too large. Maximum 10MB" },
          { status: 400 }
        )
      }

      // Verify the real file content matches the declared MIME (defence vs. a
      // spoofed Content-Type persisting a mislabeled file). Mirrors the guard
      // on /api/portal/payment/manual.
      const head = new Uint8Array(await file.slice(0, MAGIC_BYTE_PREFIX).arrayBuffer())
      if (!matchesMagic(head, file.type)) {
        return NextResponse.json(
          { error: "File content does not match its type" },
          { status: 400 }
        )
      }

      let clientId: string
      if (caller.type === "client") {
        clientId = caller.clientId
      } else {
        if (!clientIdParam) {
          return NextResponse.json(
            { error: "clientId is required for staff uploads" },
            { status: 400 }
          )
        }
        clientId = clientIdParam
      }

      const client = await prisma.client.findUnique({
        where: { id: clientId, tenantId: tenant.id },
        select: { id: true, popiaConsentGiven: true, idNumber: true },
      })
      if (!client) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 })
      }

      const uploaded = Buffer.from(await file.arrayBuffer())
      // SA banks password-protect emailed statements. An encrypted PDF cannot
      // be rasterised for extraction and cannot be previewed by staff, so the
      // encryption is stripped ONCE here rather than at every later reader.
      // This must precede saveFile/sha256DocumentBytes so contentSha256 binds
      // exactly the bytes stored on disk.
      const decryption = await decryptPdfIfEncrypted(
        uploaded,
        clientPdfPasswordCandidates(client),
      )
      if (!decryption.ok) {
        return NextResponse.json(
          {
            error: decryption.reason === "password_unknown"
              ? "This PDF is password-protected and could not be opened. Ask for a copy without a password, or check the client's ID number is correct on file."
              : "This PDF could not be processed. Please try again or contact support.",
          },
          { status: 422 }
        )
      }
      const buffer = decryption.bytes
      const { storagePath, fileSize } = await saveFile(buffer, file.type)
      const contentSha256 = sha256DocumentBytes(buffer)
      const shouldExtract = caller.type === "staff" || client.popiaConsentGiven
      const extractionGeneration = shouldExtract ? randomUUID() : null
      const extractionStartedAt = shouldExtract ? new Date() : null

      const doc = await prisma.clientDocument.create({
        data: {
          tenantId: tenant.id,
          clientId,
          docType: docType as DocType,
          fileUrl: "",
          fileName: file.name,
          mimeType: file.type,
          fileSize,
          storagePath,
          contentSha256,
          uploadedByType: caller.type,
          uploadedById: caller.type === "staff" ? caller.userId : caller.clientId,
          extractionStatus: shouldExtract ? "processing" : "skipped",
          extractionGeneration,
          extractionStartedAt,
        },
      } as never) as unknown as {
        id: string
        tenantId: string
        clientId: string
        docType: DocType
        fileUrl: string
        fileName: string
        mimeType: string | null
        fileSize: number | null
        storagePath: string | null
        uploadedByType: string
        uploadedById: string
        extractionStatus: string
        extractionGeneration: string | null
        extractionStartedAt: Date | null
      }

      // The stored file is no longer byte-identical to what was uploaded, so
      // the trail has to say so — an auditor comparing the client's original
      // against our copy needs to know the encryption was stripped, by whom,
      // and when. The original encrypted bytes are deliberately not retained.
      if (decryption.decrypted) {
        // logAuditStrict, not logAudit: this is the ONLY record that the bytes
        // we stored are not the bytes the client sent. logAudit swallows
        // its failure to a console line, which would leave an altered document
        // with nothing recording the alteration.
        await logAuditStrict({
          tenantId: tenant.id,
          userId: caller.type === "staff" ? caller.userId : undefined,
          action: AuditAction.DOCUMENT_DECRYPTED_AT_INTAKE,
          entity: "ClientDocument",
          entityId: doc.id,
          // Both hashes: without the original there is nothing for an auditor
          // to compare our copy against, which is the entry's whole purpose.
          oldValue: { contentSha256: sha256DocumentBytes(uploaded) },
          newValue: {
            fileName: file.name,
            docType,
            contentSha256,
            uploadedByType: caller.type,
            reason: "Password-protected PDF; encryption stripped so the document can be extracted and previewed",
            // The rewrite erases appended revisions; the statement checks read
            // this count instead (lib/statement-analysis/persist.ts).
            originalIncrementalUpdates: countIncrementalUpdates(uploaded),
          },
        })
      }

      // A bank statement is also read down to its transactions for the credit
      // checks (lib/statement-analysis), under the same consent gate.
      if (shouldExtract && docType === "BANK_STATEMENT") {
        // Its findings are raised as soon as it is read, before anyone opens the application.
        readStatementInBackground(tenant.id, doc.id, { onRead: () => recomputeClientApplications(tenant.id, clientId) })
      }

      // Fire-and-forget VLM extraction + validation
      // Staff uploads always run (due diligence); portal uploads require POPIA consent
      if (shouldExtract && extractionGeneration) {
        const attempt: UploadExtractionAttempt = {
          documentId: doc.id,
          tenantId: tenant.id,
          clientId,
          generation: extractionGeneration,
        }
        void extractDocumentData({
          fileBuffer: buffer,
          mimeType: file.type,
          docType,
        })
          .then(async (result) => {
            if (result.ok && result.data) {
              const extractedData = result.data
              await prisma.$transaction(async (tx) => {
                await lockAffordabilityClientEvidence(tx, {
                  tenantId: tenant.id,
                  clientId,
                })

                const current = await tx.clientDocument.findFirst({
                  where: {
                    id: doc.id,
                    tenantId: tenant.id,
                    clientId,
                    deletedAt: null,
                    extractionStatus: "processing",
                    extractionGeneration,
                  },
                  select: { id: true },
                } as never)
                if (!current) return

                let validationResult: Prisma.InputJsonValue
                let validationMismatch: boolean
                let validationScore: number
                try {
                  const validation = await validateDocumentAgainstClient(
                    extractedData,
                    docType,
                    clientId,
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
                  await tx.clientDocument.updateMany({
                    where: {
                      id: doc.id,
                      tenantId: tenant.id,
                      clientId,
                      deletedAt: null,
                      extractionStatus: "processing",
                      extractionGeneration,
                    },
                    data: {
                      extractionStatus: "failed",
                      extractionStartedAt: null,
                      extractionResult: extractedData as unknown as Prisma.InputJsonValue,
                      extractionError: validationFailure,
                      validationResult: Prisma.DbNull,
                      validationMismatch: true,
                      validationScore: null,
                    },
                  } as never)
                  return
                }

                await tx.clientDocument.updateMany({
                  where: {
                    id: doc.id,
                    tenantId: tenant.id,
                    clientId,
                    deletedAt: null,
                    extractionStatus: "processing",
                    extractionGeneration,
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
              })
              // A payslip's figures and its name/ID check feed the credit checks:
              // raise what they show now, not when someone next opens the application.
              // Its own failure must not mark the finished extraction as failed.
              if (docType === "PAYSLIP") {
                await recomputeClientApplications(tenant.id, clientId).catch((err) => {
                  console.error("[document-upload] credit-check recompute failed:", { documentId: doc.id, error: err instanceof Error ? err.name : "unknown" })
                })
              }
            } else {
              const extractionUnavailable = result.error?.includes('AI document extraction is not configured')
              await failUploadExtraction(
                attempt,
                extractionUnavailable ? "skipped" : "failed",
                result.error ?? "Unknown error",
              )
            }
          })
          .catch(async (err) => {
            console.error("[document-upload] background extraction failed:", err)
            try {
              await failUploadExtraction(attempt, "failed", String(err))
            } catch (stateError) {
              console.error("[document-upload] failed to persist extraction failure:", stateError)
            }
          })
      }

      // A signed agreement returned by a client has ONE recording path:
      // /signing-packet + agreement/sign, which binds it to the exact PASQ and
      // agreement digests. This route stores a loose client document and
      // reports success, so staff who use it believe the loan is papered while
      // agreementSignedAt stays null and disbursement keeps refusing. Say so
      // here rather than letting the file sit inert. Core KYC types are the
      // correct use of this route and are never warned about — a banner shown
      // on every upload is a banner nobody reads.
      //
      // STAFF ONLY. The remedy names "Upload and Record Signed Packet", a
      // control that exists solely on the staff Credit Agreement panel. The
      // portal offers "OTHER" as a client-selectable type, so showing this to
      // a consumer mid-signing-ceremony would instruct them to perform a staff
      // action they have no UI for — a false statement in a regulated flow.
      // A client-facing equivalent is deliberately NOT invented here.
      // Narrowed by the VALID_DOC_TYPES guard above, same as the create call.
      const warnableDocType =
        caller.type === "staff" && !CORE_KYC_DOC_TYPES.has(docType as DocType)
      // The document is already committed. A failure here must never turn a
      // successful upload into a 500 — the caller would retry and store the
      // same file twice, on exactly the path this warning exists to protect.
      let pendingAgreement: { id: string; reference: string } | null = null
      if (warnableDocType) {
        try {
          pendingAgreement = await prisma.loanApplication.findFirst({
            where: {
              tenantId: tenant.id,
              clientId,
              status: "APPROVED",
              agreementSignedAt: null,
            },
            select: { id: true, reference: true },
            orderBy: { createdAt: "desc" },
          })
        } catch (warningError) {
          console.error(
            "[document-upload] signed-agreement warning lookup failed:",
            warningError,
          )
        }
      }

      return NextResponse.json({
        ...sanitiseDoc(doc as unknown as Record<string, unknown>),
        ...(pendingAgreement
          ? {
              signedAgreementWarning: {
                applicationId: pendingAgreement.id,
                reference: pendingAgreement.reference,
                message: `Stored as a client document only. This file is NOT recorded as the signed credit agreement for ${pendingAgreement.reference}, and that application still cannot be disbursed. If this is the client's signed packet, record it on the application's Credit Agreement panel with "Upload and Record Signed Packet".`,
              },
            }
          : {}),
      }, {
        status: 201,
      })
    } catch (error) {
      console.error("Document upload failed:", error)
      return NextResponse.json(
        { error: "Failed to upload document" },
        { status: 500 }
      )
    }
  })
}
