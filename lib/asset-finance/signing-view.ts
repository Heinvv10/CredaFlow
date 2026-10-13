// Read models for deal signing: the staff deal page's "Documents & signing"
// panel and the portal's "Documents to sign" lists. JSON-safe.
import type { AssetDealStatus, DealDocumentKind, DealSignerRole, SignatureMethod } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { signerState, type SignerState } from "./signing"
import { portalSignerAuthorityWhere } from "./portal-access"
import { currentRequiredSigners } from "./signing-prepare"

export interface StaffSignerView {
  id: string
  clientId: string
  name: string
  role: DealSignerRole
  document: DealDocumentKind
  state: SignerState
  method: SignatureMethod | null
  documentSha256: string | null
  signedAt: string | null
  scanDocumentId: string | null
  scanUploadedBy: { id: string; label: string } | null
  confirmedBy: string | null
  confirmedAt: string | null
}

export interface StaffSigningPanel {
  dealStatus: AssetDealStatus
  entityId: string
  legalWordingApproved: boolean
  signers: StaffSignerView[]
  /**
   * Required now but without a signer row (someone added since preparation),
   * while the documents can still be prepared again. Once signing has started
   * the prepared signer set is the contract's (preparedSigners): nobody added
   * later is required.
   */
  missing: { clientId: string; name: string; document: DealDocumentKind }[]
  /** Documents can be (re)prepared: APPROVED and nothing recorded yet. */
  canPrepare: boolean
}

const DOCUMENT_ORDER: Record<DealDocumentKind, number> = { AGREEMENT: 0, RESOLUTION: 1, SURETYSHIP: 2 }

const userLabel = (u: { name: string | null; email: string }) => u.name?.trim() || u.email

export async function loadStaffSigningPanel(tenantId: string, dealId: string): Promise<StaffSigningPanel | null> {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: { status: true, entityId: true } })
  if (!deal) return null
  const [rows, config] = await Promise.all([
    prisma.dealSigner.findMany({
      where: { tenantId, dealId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { client: { select: { firstName: true, lastName: true } } },
    }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { assetFinanceLegalWordingApproved: true } }),
  ])
  const canPrepare = deal.status === "APPROVED" && rows.every((r) => r.method === null)
  const required = canPrepare ? await currentRequiredSigners(prisma, tenantId, deal.entityId) : []
  const present = new Set(rows.map((r) => `${r.document}:${r.clientId}`))
  const missingRequired = required.filter((s) => !present.has(`${s.document}:${s.clientId}`))
  const missingClients = await prisma.client.findMany({
    where: { tenantId, id: { in: missingRequired.map((s) => s.clientId) } },
    select: { id: true, firstName: true, lastName: true },
  })
  const missingNames = new Map(missingClients.map((c) => [c.id, `${c.firstName} ${c.lastName}`]))
  const userIds = [...new Set(rows.flatMap((r) => [r.scanUploadedById, r.confirmedById]).filter((id): id is string => id !== null))]
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true, email: true } })
  const labels = new Map(users.map((u) => [u.id, userLabel(u)]))
  return {
    dealStatus: deal.status,
    entityId: deal.entityId,
    legalWordingApproved: config?.assetFinanceLegalWordingApproved === true,
    canPrepare,
    missing: missingRequired.map((s) => ({ clientId: s.clientId, name: missingNames.get(s.clientId) ?? s.clientId, document: s.document })),
    signers: [...rows].sort((a, b) => DOCUMENT_ORDER[a.document] - DOCUMENT_ORDER[b.document]).map((r) => ({
      id: r.id,
      clientId: r.clientId,
      name: `${r.client.firstName} ${r.client.lastName}`,
      role: r.role,
      document: r.document,
      state: signerState(r),
      method: r.method,
      documentSha256: r.documentSha256,
      signedAt: r.signedAt?.toISOString() ?? null,
      scanDocumentId: r.scanDocumentId,
      scanUploadedBy: r.scanUploadedById ? { id: r.scanUploadedById, label: labels.get(r.scanUploadedById) ?? r.scanUploadedById } : null,
      confirmedBy: r.confirmedById ? (labels.get(r.confirmedById) ?? r.confirmedById) : null,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
    })),
  }
}

export interface PortalSignerView {
  id: string
  document: DealDocumentKind
  dealReference: string
  entityName: string
  state: SignerState
  /** Signing is open: the deal is APPROVED and nothing is recorded on the row. */
  canSign: boolean
}

/** The client's OWN signer rows, optionally for one entity's deals. Never anyone else's. */
export async function loadPortalSigners(tenantId: string, clientId: string, entityId?: string): Promise<PortalSignerView[]> {
  const rows = await prisma.dealSigner.findMany({
    // Only rows the client may still open: a surety while SURETY, a signatory while they hold authority.
    where: {
      tenantId, clientId, deal: { status: { in: ["APPROVED", "CONTRACTED", "BOOKED"] }, ...(entityId ? { entityId } : {}) },
      AND: [portalSignerAuthorityWhere(tenantId, clientId)],
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, document: true, method: true, signedAt: true, signatureSha256: true,
      scanDocumentId: true, confirmedById: true, confirmedAt: true,
      deal: { select: { status: true, application: { select: { reference: true } }, entity: { select: { legalName: true } } } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    document: r.document,
    dealReference: r.deal.application.reference,
    entityName: r.deal.entity.legalName,
    state: signerState(r),
    canSign: r.deal.status === "APPROVED" && r.method === null,
  }))
}
