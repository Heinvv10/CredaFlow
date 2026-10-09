import { Prisma } from "@prisma/client"
import { documentBytesMatchSha256, isSha256Digest } from "@/lib/documents/content-integrity"
import { readFile } from "@/lib/storage"

interface PasqDocumentDb {
  clientDocument: {
    findFirst(args: unknown): Promise<{
      id: string
      storagePath: string | null
      contentSha256: string | null
    } | null>
  }
  $queryRaw?<T = unknown>(query: unknown): Promise<T>
}

export type VerifiedPasqDocumentArtifact =
  | {
      ok: true
      document: { id: string; storagePath: string; contentSha256: string | null }
      bytes: Buffer
    }
  | { ok: false; reason: "invalid_hash" | "missing" | "bytes_unavailable" | "hash_mismatch" }

export async function verifyPasqDocumentArtifact(
  db: PasqDocumentDb,
  args: {
    tenantId: string
    clientId: string
    documentId: string
    documentSha256: string
    lock?: boolean
  },
): Promise<VerifiedPasqDocumentArtifact> {
  if (!isSha256Digest(args.documentSha256)) {
    return { ok: false, reason: "invalid_hash" }
  }
  if (args.lock) {
    if (!db.$queryRaw) return { ok: false, reason: "missing" }
    const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ClientDocument"
      WHERE "id" = ${args.documentId}
        AND "tenantId" = ${args.tenantId}
        AND "clientId" = ${args.clientId}
        AND "docType" = 'FORM_20_PRE_AGREEMENT'::"DocType"
        AND "deletedAt" IS NULL
        AND "contentSha256" = ${args.documentSha256}
      FOR SHARE
    `)
    if (rows[0]?.id !== args.documentId) {
      return { ok: false, reason: "missing" }
    }
  }
  const document = await db.clientDocument.findFirst({
    where: {
      id: args.documentId,
      tenantId: args.tenantId,
      clientId: args.clientId,
      docType: "FORM_20_PRE_AGREEMENT",
      deletedAt: null,
      contentSha256: args.documentSha256,
      storagePath: { not: null },
    },
    select: { id: true, storagePath: true, contentSha256: true },
  })
  if (!document?.storagePath) return { ok: false, reason: "missing" }
  let bytes: Buffer
  try {
    bytes = await readFile(document.storagePath)
  } catch {
    return { ok: false, reason: "bytes_unavailable" }
  }
  if (!documentBytesMatchSha256(bytes, args.documentSha256)) {
    return { ok: false, reason: "hash_mismatch" }
  }
  return {
    ok: true,
    document: { ...document, storagePath: document.storagePath },
    bytes,
  }
}
