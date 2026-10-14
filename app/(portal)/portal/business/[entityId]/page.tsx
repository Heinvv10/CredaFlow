import { notFound } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { DocumentsPanel } from "@/components/asset-finance/DocumentsPanel"
import { EntityRecordsTables } from "@/components/asset-finance/EntityRecordsTables"
import { PortalEntitySwitcher } from "@/components/asset-finance/PortalEntitySwitcher"
import { PortalSignerList } from "@/components/asset-finance/PortalSignerList"
import { requirePortalEntityPage } from "@/lib/asset-finance/portal-page"
import { loadPortalEntities, loadPortalEntityView } from "@/lib/asset-finance/portal-entities"
import { loadPortalEntityDocuments } from "@/lib/asset-finance/portal-access"
import { PORTAL_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"
import { loadPortalSigners } from "@/lib/asset-finance/signing-view"
import { prisma } from "@/lib/prisma"
import { PortalNcaDealActions, type PortalNcaDealAction } from "@/components/asset-finance/PortalNcaDealActions"

export default async function PortalEntityPage({ params }: { params: Promise<{ entityId: string }> }) {
  const { entityId } = await params
  // 404 unless this client is an active director, trustee or authorised signatory.
  const { tenantId, clientId } = await requirePortalEntityPage(entityId)
  const [view, entities, documents, signers, ncaDeals] = await Promise.all([
    loadPortalEntityView(tenantId, entityId),
    loadPortalEntities(tenantId, clientId),
    loadPortalEntityDocuments(tenantId, entityId, clientId),
    loadPortalSigners(tenantId, clientId, entityId),
    prisma.assetFinanceDeal.findMany({ where: {
      tenantId, entityId, application: { ncaRegime: "NCA" }, OR: [
        { status: { in: ["SUBMITTED", "REFERRED"] }, application: { creditLifeElection: null } },
        { status: "APPROVED", application: { ncaRepresentativeClientId: clientId, pasqDocumentId: { not: null }, pasqAcknowledgedAt: null } },
      ],
    }, select: { id: true, status: true, application: { select: {
      reference: true, creditLifeElection: true, pasqDocumentId: true, pasqDocumentSha256: true,
    } } }, orderBy: { createdAt: "asc" } }),
  ])
  if (!view) notFound()
  const { entity, ...records } = view
  const actions: PortalNcaDealAction[] = ncaDeals.flatMap((deal): PortalNcaDealAction[] => {
    if (!deal.application.creditLifeElection && ["SUBMITTED", "REFERRED"].includes(deal.status)) {
      return [{ dealId: deal.id, reference: deal.application.reference, stage: "CREDIT_LIFE" as const }]
    }
    if (deal.application.pasqDocumentId && deal.application.pasqDocumentSha256) return [{
      dealId: deal.id, reference: deal.application.reference, stage: "QUOTE" as const,
      documentId: deal.application.pasqDocumentId, documentSha256: deal.application.pasqDocumentSha256,
    }]
    return []
  })

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-6">
      <PortalEntitySwitcher entities={entities} currentId={entityId} />
      <DataPanel title={entity.legalName} description={`${ENTITY_TYPE_LABELS[entity.type]} · ${entity.registrationNumber}`}>
        <p className="text-sm text-[var(--cf-text-secondary)]">
          {entity.tradingName ? `Trading as ${entity.tradingName}. ` : ""}
          You can see this business&apos;s applications and finance agreements and send us its documents.
        </p>
      </DataPanel>
      <DataPanel title="Documents to sign" description="Your own signatures on this business's finance documents">
        <PortalSignerList signers={signers} showEntity={false} />
      </DataPanel>
      <DataPanel title="NCA deal actions" description="Credit-life disclosure and quotation acknowledgement">
        <PortalNcaDealActions entityId={entityId} actions={actions} />
      </DataPanel>
      <DocumentsPanel
        apiBase={`/api/portal/asset-finance/entities/${entityId}/documents`}
        documents={documents}
        uploadTypes={PORTAL_UPLOAD_DOC_TYPES}
        canUpload
        canManage={false}
      />
      <EntityRecordsTables records={records} loanHref={(loanId) => `/portal/business/${entityId}/contracts/${loanId}`} />
    </div>
  )
}
