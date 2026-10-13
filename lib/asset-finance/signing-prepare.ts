// Prepare an APPROVED deal's documents for signing (goal §4.9): render the
// agreement, the resolution and a suretyship per surety, store each PDF once
// in the same storage as entity documents (lib/storage), and create one
// DealSigner row per required signature binding those bytes by sha256.
//
// Unsigned documents are NOT EntityDocument rows: a SIGNED_* EntityDocument is
// only ever a wet-ink scan (./signing-wet-ink.ts), so a draft is never listed
// or mistaken for executed evidence. The signer row holds the bytes' path and
// digest; every read of them is logged against the signer row's id.
//
// Idempotent while nothing is recorded: preparing again re-renders, re-binds
// the rows and drops rows no longer required. Once any signature or scan is
// on record it is refused (and guardDealSigner refuses it in the database).
import { Prisma, type AssetDealStatus, type DealDocumentKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import { deriveRequiredSigners, type RequiredSigner } from "./signing"

export type SigningTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface SigningActor {
  tenantId: string
  userId: string
  userEmail?: string | null
}

export type PrepareResult =
  | { kind: "not_found" }
  | { kind: "not_approved"; status: AssetDealStatus }
  | { kind: "signing_started" }
  | { kind: "no_authority" }
  | { kind: "people_changed" }
  | { kind: "prepared"; signers: number }

interface StoredDocument {
  sha256: string
  storagePath: string
}

const signerKey = (s: { clientId: string; document: DealDocumentKind }) => `${s.document}:${s.clientId}`
const documentKey = (s: { clientId: string; document: DealDocumentKind }) =>
  s.document === "SURETYSHIP" ? signerKey(s) : s.document

/** Lock the deal row for the transaction; null when it is not this tenant's. */
export async function lockDeal(
  tx: SigningTx,
  tenantId: string,
  dealId: string,
): Promise<{ status: AssetDealStatus; entityId: string } | null> {
  const rows = await tx.$queryRaw<Array<{ status: AssetDealStatus; entityId: string }>>(Prisma.sql`
    SELECT "status", "entityId" FROM "AssetFinanceDeal"
    WHERE "id" = ${dealId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)
  return rows[0] ?? null
}

/** The required set as it stands now, read inside the transaction. */
export async function currentRequiredSigners(
  tx: SigningTx,
  tenantId: string,
  entityId: string,
): Promise<RequiredSigner[]> {
  const entity = await tx.businessEntity.findFirstOrThrow({ where: { id: entityId, tenantId }, select: { type: true } })
  const relationships = await tx.entityRelationship.findMany({
    where: { tenantId, entityId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { clientId: true, role: true, active: true },
  })
  return deriveRequiredSigners(entity.type, relationships)
}

export async function prepareDealDocuments(actor: SigningActor, dealId: string): Promise<PrepareResult> {
  const { tenantId } = actor
  const status = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: { status: true } })
  if (!status) return { kind: "not_found" }
  if (status.status !== "APPROVED") return { kind: "not_approved", status: status.status }

  // Throws DealDocumentError / LenderIdentityError: the caller refuses with the reason.
  const data = await loadDealDocumentData(prisma, tenantId, dealId)
  if (!data) return { kind: "not_found" }
  if (!data.requiredSigners.some((s) => s.document === "AGREEMENT")) return { kind: "no_authority" }

  const stored = new Map<string, StoredDocument>()
  try {
    for (const signer of data.requiredSigners) {
      const key = documentKey(signer)
      if (stored.has(key)) continue
      const rendered = await renderDealDocument(data, signer.document, signer.clientId)
      const { storagePath } = await saveFile(rendered.bytes, "application/pdf")
      stored.set(key, { sha256: rendered.sha256, storagePath })
    }
    const result = await prisma.$transaction(async (tx) => {
      const deal = await lockDeal(tx, tenantId, dealId)
      if (!deal) return { result: { kind: "not_found" } as const, released: [] }
      if (deal.status !== "APPROVED") return { result: { kind: "not_approved", status: deal.status } as const, released: [] }
      const existing = await tx.dealSigner.findMany({
        where: { tenantId, dealId },
        select: { id: true, clientId: true, document: true, method: true, documentStoragePath: true },
      })
      if (existing.some((row) => row.method !== null)) return { result: { kind: "signing_started" } as const, released: [] }
      const now = await currentRequiredSigners(tx, tenantId, deal.entityId)
      if (now.map(signerKey).join("|") !== data.requiredSigners.map(signerKey).join("|")) {
        return { result: { kind: "people_changed" } as const, released: [] }
      }

      const wanted = new Set(now.map(signerKey))
      const stale = existing.filter((row) => !wanted.has(signerKey(row)))
      if (stale.length > 0) await tx.dealSigner.deleteMany({ where: { tenantId, id: { in: stale.map((r) => r.id) } } })
      const bound = []
      for (const signer of now) {
        const doc = stored.get(documentKey(signer))
        if (!doc) throw new Error(`No rendered document for ${signerKey(signer)}`)
        const binding = { documentSha256: doc.sha256, documentStoragePath: doc.storagePath }
        await tx.dealSigner.upsert({
          where: { dealId_clientId_document: { dealId, clientId: signer.clientId, document: signer.document } },
          create: { tenantId, dealId, clientId: signer.clientId, role: signer.role, document: signer.document, ...binding },
          update: binding,
        })
        bound.push({ clientId: signer.clientId, document: signer.document, documentSha256: doc.sha256 })
      }
      await logAuditStrict(
        {
          tenantId,
          userId: actor.userId,
          userEmail: actor.userEmail ?? undefined,
          action: AuditAction.ASSET_DEAL_DOCUMENTS_PREPARED,
          entity: "AssetFinanceDeal",
          entityId: dealId,
          newValue: { signers: bound, removedSigners: stale.map(signerKey), legalWordingApproved: data.legalWordingApproved },
        },
        tx,
      )
      return {
        result: { kind: "prepared", signers: bound.length } as const,
        released: existing.map((row) => row.documentStoragePath).filter((p): p is string => p !== null),
      }
    })
    // Bytes no row points at any more (an earlier preparation), or that this
    // attempt wrote and did not bind, hold personal data: remove them.
    const kept = result.result.kind === "prepared" ? new Set([...stored.values()].map((d) => d.storagePath)) : new Set<string>()
    const unused = [...result.released, ...[...stored.values()].map((d) => d.storagePath)].filter((p) => !kept.has(p))
    await Promise.all([...new Set(unused)].map((p) => deleteFile(p)))
    return result.result
  } catch (error) {
    await Promise.all([...stored.values()].map((d) => deleteFile(d.storagePath)))
    throw error
  }
}
