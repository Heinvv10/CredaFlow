import { NextResponse } from "next/server"
import type { EntityDocumentType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { deleteFile, readFile, saveFile } from "@/lib/storage"
import {
  ALLOWED_MIME_TYPES,
  MAGIC_BYTE_PREFIX,
  MAX_FILE_SIZE,
  logDocumentAccess,
  matchesMagic,
} from "@/lib/document-auth"
import { documentBytesMatchSha256, sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { ENTITY_DOCUMENT_VIEW_SELECT, lockBusinessEntity, toEntityDocumentView, type EntityDocumentView } from "./entity-documents"
import { entityDocumentDisposition as contentDisposition } from "./content-disposition"

// Upload and download of EntityDocument bytes, shared by the staff and portal
// routes. Uploads pass the same MIME allow-list, size cap and magic-byte check
// as ClientDocument uploads (lib/document-auth.ts) and land in the same
// storage. Every read writes a DocumentAccessLog row before the bytes are read.

export interface ParsedEntityUpload {
  file: File
  docType: EntityDocumentType
  dealId: string | null
}

export type ParseUploadResult = { upload: ParsedEntityUpload } | { error: string }

export async function parseEntityDocumentForm(
  req: Request,
  allowedTypes: readonly EntityDocumentType[],
  { allowDeal }: { allowDeal: boolean },
): Promise<ParseUploadResult> {
  const form = await req.formData().catch(() => null)
  if (!form) return { error: "Expected multipart form data" }
  const file = form.get("file")
  const docType = form.get("docType")
  const dealId = form.get("dealId")
  if (!(file instanceof File)) return { error: "file is required" }
  if (typeof docType !== "string" || !(allowedTypes as readonly string[]).includes(docType)) {
    return { error: `docType must be one of ${allowedTypes.join(", ")}` }
  }
  if (dealId !== null && (!allowDeal || typeof dealId !== "string" || dealId.trim() === "")) {
    return { error: allowDeal ? "dealId must be a deal id" : "dealId is not accepted here" }
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type)) return { error: "File type not allowed. Accepted: JPEG, PNG, WebP, PDF" }
  if (file.size === 0) return { error: "The file is empty" }
  if (file.size > MAX_FILE_SIZE) return { error: "File too large. Maximum 10MB" }
  const head = new Uint8Array(await file.slice(0, MAGIC_BYTE_PREFIX).arrayBuffer())
  if (!matchesMagic(head, file.type)) return { error: "File content does not match its type" }
  return { upload: { file, docType: docType as EntityDocumentType, dealId: typeof dealId === "string" ? dealId.trim() : null } }
}

/** A file name safe to echo inside a quoted Content-Disposition header. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").trim().slice(0, 200)
  return cleaned.length > 0 ? cleaned : "document"
}

export function entityDocumentDisposition(disposition: "inline" | "attachment", name: string): string {
  return contentDisposition(disposition, name, safeFileName)
}

type EntityDocumentTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface EntityDocumentUploader {
  type: "staff" | "client"
  id: string
  email?: string
}

/** The entity already holds `cap` live documents; nothing was stored. */
export class EntityDocumentCapError extends Error {
  constructor(readonly cap: number) {
    super(`The entity already holds ${cap} documents; delete one before uploading another`)
    this.name = "EntityDocumentCapError"
  }
}

/**
 * Store the bytes, then the row and its audit entry in one transaction.
 * `withinTransaction` runs in that transaction after the row exists (the
 * wet-ink signing flow binds the scan to its signer there); if it throws,
 * nothing is kept. With `liveDocumentCap` the entity row is locked and an
 * entity already holding that many live documents throws
 * EntityDocumentCapError (the lock makes concurrent uploads count in turn).
 */
export async function storeEntityDocument(params: {
  tenantId: string
  entityId: string
  upload: ParsedEntityUpload
  uploader: EntityDocumentUploader
  liveDocumentCap?: number
  withinTransaction?: (tx: EntityDocumentTx, document: { id: string; contentSha256: string }) => Promise<void>
}): Promise<EntityDocumentView> {
  const { tenantId, entityId, upload, uploader } = params
  const buffer = Buffer.from(await upload.file.arrayBuffer())
  const { storagePath, fileSize } = await saveFile(buffer, upload.file.type)
  const contentSha256 = sha256DocumentBytes(buffer)
  try {
    const row = await prisma.$transaction(async (tx) => {
      if (params.liveDocumentCap !== undefined) {
        await lockBusinessEntity(tx, tenantId, entityId)
        const live = await tx.entityDocument.count({ where: { tenantId, entityId, deletedAt: null } })
        if (live >= params.liveDocumentCap) throw new EntityDocumentCapError(params.liveDocumentCap)
      }
      const created = await tx.entityDocument.create({
        data: {
          tenantId,
          entityId,
          dealId: upload.dealId,
          docType: upload.docType,
          fileName: safeFileName(upload.file.name),
          mimeType: upload.file.type,
          fileSize,
          storagePath,
          contentSha256,
          uploadedByType: uploader.type,
          uploadedById: uploader.id,
        },
        select: ENTITY_DOCUMENT_VIEW_SELECT,
      })
      await logAuditStrict(
        {
          tenantId,
          userId: uploader.type === "staff" ? uploader.id : undefined,
          userEmail: uploader.email,
          action: AuditAction.ENTITY_DOCUMENT_UPLOADED,
          entity: "EntityDocument",
          entityId: created.id,
          newValue: {
            businessEntityId: entityId,
            dealId: upload.dealId,
            docType: upload.docType,
            contentSha256,
            uploadedByType: uploader.type,
            uploadedById: uploader.id,
          },
        },
        tx,
      )
      if (params.withinTransaction) await params.withinTransaction(tx, { id: created.id, contentSha256 })
      return created
    })
    return toEntityDocumentView(row)
  } catch (error) {
    // No row points at the bytes: remove them rather than keep unindexed PII.
    await deleteFile(storagePath)
    throw error
  }
}

export interface ServableEntityDocument {
  id: string
  fileName: string
  mimeType: string
  storagePath: string
  contentSha256: string
}

/**
 * Log the access, then return the bytes. The caller has already decided the
 * accessor may read this document. `?download=1` serves it as an attachment.
 */
export async function serveEntityDocument(
  req: Request,
  doc: ServableEntityDocument,
  accessor: { type: "staff" | "client"; id: string },
): Promise<NextResponse> {
  const isDownload = new URL(req.url).searchParams.get("download") === "1"
  await logDocumentAccess(prisma, {
    documentId: doc.id,
    accessorType: accessor.type,
    accessorId: accessor.id,
    action: isDownload ? "download" : "view",
    req,
  })
  const buffer = await readFile(doc.storagePath)
  if (!documentBytesMatchSha256(buffer, doc.contentSha256)) {
    return NextResponse.json({ error: "The document failed its integrity check and cannot be served" }, { status: 422 })
  }
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      "Content-Disposition": entityDocumentDisposition(isDownload ? "attachment" : "inline", doc.fileName),
      "Content-Length": String(buffer.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
