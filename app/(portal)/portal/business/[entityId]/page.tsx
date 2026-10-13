import { notFound } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { DocumentsPanel } from "@/components/asset-finance/DocumentsPanel"
import { EntityRecordsTables } from "@/components/asset-finance/EntityRecordsTables"
import { PortalEntitySwitcher } from "@/components/asset-finance/PortalEntitySwitcher"
import { PortalSignerList } from "@/components/asset-finance/PortalSignerList"
import { requirePortalEntityPage } from "@/lib/asset-finance/portal-page"
import { loadPortalEntities, loadPortalEntityView } from "@/lib/asset-finance/portal-entities"
import { loadEntityDocuments } from "@/lib/asset-finance/entity-detail"
import { PORTAL_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"
import { loadPortalSigners } from "@/lib/asset-finance/signing-view"

export default async function PortalEntityPage({ params }: { params: Promise<{ entityId: string }> }) {
  const { entityId } = await params
  // 404 unless this client is an active director, trustee or authorised signatory.
  const { tenantId, clientId } = await requirePortalEntityPage(entityId)
  const [view, entities, documents, signers] = await Promise.all([
    loadPortalEntityView(tenantId, entityId),
    loadPortalEntities(tenantId, clientId),
    loadEntityDocuments(tenantId, entityId),
    loadPortalSigners(tenantId, clientId, entityId),
  ])
  if (!view) notFound()
  const { entity, ...records } = view

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
