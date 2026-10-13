// APPROVED → CONTRACTED once every required signature is in (goal §4.9). The
// route answers 409 with the outstanding signers; the database refuses the
// same move on its own (guardAssetDealContract), so no other path can skip it.
// The payout checklist is created in the same transaction (§4.10).
import type { AssetDealStatus, DealDocumentKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { createPayoutChecklist } from "./payout-checklist-store"
import { outstandingSigners, type Outstanding } from "./signing"
import { currentRequiredSigners, lockDeal, type SigningActor } from "./signing-prepare"

export interface OutstandingView extends Outstanding {
  name: string
}

export type ContractResult =
  | { kind: "not_found" }
  | { kind: "not_approved"; status: AssetDealStatus }
  | { kind: "no_authority" }
  | { kind: "incomplete"; outstanding: OutstandingView[] }
  | { kind: "contracted" }

export async function contractDeal(actor: SigningActor, dealId: string): Promise<ContractResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, tenantId, dealId)
    if (!deal) return { kind: "not_found" }
    if (deal.status !== "APPROVED") return { kind: "not_approved", status: deal.status }
    const required = await currentRequiredSigners(tx, tenantId, deal.entityId)
    if (!required.some((s) => s.document === "AGREEMENT")) return { kind: "no_authority" }
    const rows = await tx.dealSigner.findMany({
      where: { tenantId, dealId },
      select: {
        clientId: true, document: true, method: true, signedAt: true, signatureSha256: true,
        scanDocumentId: true, confirmedById: true, confirmedAt: true,
      },
    })
    const outstanding = outstandingSigners(required, rows)
    if (outstanding.length > 0) {
      const clients = await tx.client.findMany({
        where: { tenantId, id: { in: outstanding.map((o) => o.clientId) } },
        select: { id: true, firstName: true, lastName: true },
      })
      const names = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`]))
      return { kind: "incomplete", outstanding: outstanding.map((o) => ({ ...o, name: names.get(o.clientId) ?? o.clientId })) }
    }
    await tx.assetFinanceDeal.updateMany({ where: { id: dealId, tenantId, status: "APPROVED" }, data: { status: "CONTRACTED" } })
    await createPayoutChecklist(tx, tenantId, dealId)
    const signed: { clientId: string; document: DealDocumentKind; method: string | null }[] = rows.map((r) => ({
      clientId: r.clientId, document: r.document, method: r.method,
    }))
    await logAuditStrict(
      {
        tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? undefined,
        action: AuditAction.ASSET_DEAL_CONTRACTED,
        entity: "AssetFinanceDeal",
        entityId: dealId,
        oldValue: { status: "APPROVED" },
        newValue: { status: "CONTRACTED", signers: signed },
      },
      tx,
    )
    return { kind: "contracted" }
  })
}
