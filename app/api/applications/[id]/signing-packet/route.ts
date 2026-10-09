import { createHash, randomUUID } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { Prisma } from "@prisma/client"
import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole, requireOwnerOrStaff } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { deleteFile, readFile, saveFile } from "@/lib/storage"
import {
  documentBytesMatchSha256,
  isSha256Digest,
} from "@/lib/documents/content-integrity"
import { createSigningPacketPdf } from "@/lib/pdf/signingPacket"
import { AuditAction } from "@/lib/audit"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * The application moved between the pre-transaction read and the binding write
 * — the signature was recorded, or the agreement/PASQ was regenerated under us.
 * Distinct from a server fault: the upload is refusable, not broken.
 */
class SignedPacketBindingRaceError extends Error {}

export async function GET(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        agreementGeneratedAt: true,
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (
      !application.agreementGeneratedAt
      || !application.pasqDocumentId
      || !application.agreementDocumentId
      || !isSha256Digest(application.pasqDocumentSha256)
      || !isSha256Digest(application.agreementDocumentSha256)
    ) {
      return NextResponse.json(
        { error: "The PASQ and credit agreement must both be prepared first." },
        { status: 409 },
      )
    }

    const [pasqDocument, agreementDocument] = await Promise.all([
      prisma.clientDocument.findFirst({
        where: {
          id: application.pasqDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "FORM_20_PRE_AGREEMENT",
          deletedAt: null,
          contentSha256: application.pasqDocumentSha256,
          storagePath: { not: null },
        },
      }),
      prisma.clientDocument.findFirst({
        where: {
          id: application.agreementDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "CREDIT_AGREEMENT",
          deletedAt: null,
          contentSha256: application.agreementDocumentSha256,
          storagePath: { not: null },
        },
      }),
    ])
    if (!pasqDocument?.storagePath || !agreementDocument?.storagePath) {
      return NextResponse.json(
        { error: "One or more signing-packet documents are unavailable." },
        { status: 422 },
      )
    }

    let pasqBytes: Buffer
    let agreementBytes: Buffer
    try {
      ;[pasqBytes, agreementBytes] = await Promise.all([
        readFile(pasqDocument.storagePath),
        readFile(agreementDocument.storagePath),
      ])
    } catch {
      return NextResponse.json(
        { error: "One or more signing-packet files are unavailable." },
        { status: 422 },
      )
    }
    if (
      !documentBytesMatchSha256(pasqBytes, application.pasqDocumentSha256)
      || !documentBytesMatchSha256(
        agreementBytes,
        application.agreementDocumentSha256,
      )
    ) {
      return NextResponse.json(
        { error: "A signing-packet document failed its integrity check." },
        { status: 422 },
      )
    }

    const accessorId = access.type === "staff" ? access.user.id : access.clientId
    await prisma.$transaction([
      prisma.documentAccessLog.create({
        data: {
          documentId: pasqDocument.id,
          accessorType: access.type,
          accessorId,
          action: "view_in_signing_packet",
          ipAddress: req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null,
        },
      }),
      prisma.documentAccessLog.create({
        data: {
          documentId: agreementDocument.id,
          accessorType: access.type,
          accessorId,
          action: "view_in_signing_packet",
          ipAddress: req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null,
        },
      }),
    ])

    const packet = await createSigningPacketPdf(pasqBytes, agreementBytes)
    const responseBytes = new Uint8Array(packet.byteLength)
    responseBytes.set(packet)
    return new Response(responseBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="pasq-credit-agreement-${id}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-PASQ-SHA256": application.pasqDocumentSha256,
        "X-Agreement-SHA256": application.agreementDocumentSha256,
      },
    })
  })
}

export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      return NextResponse.json({ error: "Invalid upload form." }, { status: 400 })
    }
    const file = form.get("file")
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "Select the signed PDF packet." }, { status: 422 })
    }
    if (form.get("attestation") !== "true") {
      return NextResponse.json(
        { error: "Confirm that the client signed the PASQ and credit agreement in this returned PDF." },
        { status: 422 },
      )
    }
    if (file.type !== "application/pdf" || file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: "The signed packet must be a PDF no larger than 10 MB." },
        { status: 422 },
      )
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      return NextResponse.json({ error: "The uploaded file is not a PDF." }, { status: 422 })
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        status: true,
        agreementSignedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        agreementDocumentId: true,
        agreementDocumentSha256: true,
        // Read the CURRENT binding so the write below can pin it. Without this
        // the CAS cannot tell "no packet bound yet" from "another upload bound
        // one while we were reading", and the later commit silently wins.
        signedPacketDocumentId: true,
        signedPacketDocumentSha256: true,
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    if (
      application.status !== "APPROVED"
      || application.agreementSignedAt
      || !application.pasqDocumentId
      || !application.agreementDocumentId
      || !isSha256Digest(application.pasqDocumentSha256)
      || !isSha256Digest(application.agreementDocumentSha256)
    ) {
      return NextResponse.json(
        { error: "Prepare the unsigned PASQ and credit agreement before recording a returned packet." },
        { status: 409 },
      )
    }

    const [pasqDocument, agreementDocument] = await Promise.all([
      prisma.clientDocument.findFirst({
        where: {
          id: application.pasqDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "FORM_20_PRE_AGREEMENT",
          deletedAt: null,
          contentSha256: application.pasqDocumentSha256,
          storagePath: { not: null },
        },
      }),
      prisma.clientDocument.findFirst({
        where: {
          id: application.agreementDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "CREDIT_AGREEMENT",
          deletedAt: null,
          contentSha256: application.agreementDocumentSha256,
          storagePath: { not: null },
        },
      }),
    ])
    if (!pasqDocument?.storagePath || !agreementDocument?.storagePath) {
      return NextResponse.json(
        { error: "The source signing-packet documents are unavailable." },
        { status: 422 },
      )
    }

    let returnedPdf: PDFDocument
    let sourcePageCount: number
    try {
      const [pasqBytes, agreementBytes] = await Promise.all([
        readFile(pasqDocument.storagePath),
        readFile(agreementDocument.storagePath),
      ])
      if (
        !documentBytesMatchSha256(pasqBytes, application.pasqDocumentSha256)
        || !documentBytesMatchSha256(
          agreementBytes,
          application.agreementDocumentSha256,
        )
      ) {
        throw new Error("source_integrity")
      }
      const [pasqPdf, agreementPdf, uploadedPdf] = await Promise.all([
        PDFDocument.load(pasqBytes),
        PDFDocument.load(agreementBytes),
        PDFDocument.load(bytes),
      ])
      returnedPdf = uploadedPdf
      sourcePageCount = pasqPdf.getPageCount() + agreementPdf.getPageCount()
    } catch {
      return NextResponse.json(
        { error: "The returned packet or its source documents are not valid intact PDFs." },
        { status: 422 },
      )
    }
    if (returnedPdf.getPageCount() < sourcePageCount) {
      return NextResponse.json(
        {
          error: `The returned packet has ${returnedPdf.getPageCount()} pages; the issued packet has ${sourcePageCount}. This is usually a half: the Form 20 and the credit agreement in the client's documents folder are two parts of one packet and cannot be signed separately. Re-issue with "Email PASQ + Agreement" or the portal signing link, have the consumer sign the whole packet, and upload that.`,
        },
        { status: 422 },
      )
    }

    const contentSha256 = createHash("sha256").update(bytes).digest("hex")
    const documentId = randomUUID()
    const stored = await saveFile(bytes, "application/pdf")
    try {
      const document = await prisma.$transaction(async (tx) => {
        const created = await tx.clientDocument.create({
          data: {
            id: documentId,
            tenantId: tenant.id,
            clientId: application.clientId,
            // Its own type, not OTHER. This is the only document that carries
            // the consumer's actual signature, and as OTHER it sat unbadged
            // among miscellaneous uploads — deletable and verifiable through
            // the generic document paths that skip this flow's own checks.
            docType: "SIGNED_AGREEMENT_PACKET",
            fileUrl: `/api/documents/${documentId}/view`,
            fileName: `signed-pasq-credit-agreement-${id}.pdf`,
            storagePath: stored.storagePath,
            fileSize: stored.fileSize,
            mimeType: "application/pdf",
            contentSha256,
            uploadedByType: "staff",
            uploadedById: guard.user.id,
            extractionStatus: "skipped",
            verified: false,
            signatureState: "returned_pending_recording",
            validationResult: {
              version: "signed-pasq-credit-agreement-v1",
              applicationId: id,
              pasqDocumentId: application.pasqDocumentId,
              pasqDocumentSha256: application.pasqDocumentSha256,
              agreementDocumentId: application.agreementDocumentId,
              agreementDocumentSha256: application.agreementDocumentSha256,
              sourcePageCount,
              returnedPageCount: returnedPdf.getPageCount(),
              staffAttestedAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        })
        // Bind the packet to the application so the documents folder can name
        // it without matching on the filename. Guarded on agreementSignedAt
        // still being NULL: re-uploading is legitimate while the signature is
        // unrecorded (the first attempt is often the wrong file), but once it
        // IS recorded the binding is the record of which bytes were signed and
        // must not move. The pre-transaction read of agreementSignedAt is
        // optimistic; this is the check that actually holds.
        //
        // The previous binding is pinned too. Postgres serialises the two
        // UPDATEs of a concurrent double upload, but WITHOUT this predicate the
        // second one's WHERE still matches after the first commits: both get
        // count === 1, both callers get a 200, and the application silently
        // keeps whichever committed last. That is a lost update on the pointer
        // the documents folder reads — it would re-create the "staff acted on
        // the wrong PDF" failure this card exists to remove, with nothing
        // anywhere saying it happened. Pinned to the value read above, so a
        // SEQUENTIAL re-upload still succeeds and only a genuine concurrent
        // writer is refused.
        const bound = await tx.loanApplication.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            clientId: application.clientId,
            agreementSignedAt: null,
            agreementDocumentId: application.agreementDocumentId,
            agreementDocumentSha256: application.agreementDocumentSha256,
            pasqDocumentId: application.pasqDocumentId,
            pasqDocumentSha256: application.pasqDocumentSha256,
            signedPacketDocumentId: application.signedPacketDocumentId,
            signedPacketDocumentSha256: application.signedPacketDocumentSha256,
          },
          data: {
            signedPacketDocumentId: documentId,
            signedPacketDocumentSha256: contentSha256,
          },
        })
        if (bound.count !== 1) {
          throw new SignedPacketBindingRaceError()
        }
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: AuditAction.SIGNED_PACKET_UPLOADED,
            entity: "LoanApplication",
            entityId: id,
            newValue: {
              signedPacketDocumentId: documentId,
              signedPacketSha256: contentSha256,
              pasqDocumentSha256: application.pasqDocumentSha256,
              agreementDocumentSha256: application.agreementDocumentSha256,
              staffAttested: true,
            },
          },
        })
        return created
      })
      return NextResponse.json({
        documentId: document.id,
        contentSha256,
        fileName: document.fileName,
      })
    } catch (error) {
      await deleteFile(stored.storagePath)
      if (error instanceof SignedPacketBindingRaceError) {
        return NextResponse.json(
          {
            // Deliberately does not assert WHO changed it. A retry of an upload
            // whose first attempt actually committed lands here too, and telling
            // that officer "someone else uploaded" would be false. Naming the
            // possibilities and pointing at the folder is true in every case.
            error: "This application changed while the packet was uploading — a returned packet was already uploaded, possibly by an earlier attempt of your own, or the signature was recorded, or the PASQ or agreement was regenerated. Nothing was saved. Re-open the application, check which returned packet is now on file, and upload again only if yours is the copy to record.",
          },
          { status: 409 },
        )
      }
      throw error
    }
  })
}
