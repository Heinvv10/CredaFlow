import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { EntityDetailsPanel } from "@/components/asset-finance/EntityDetailsPanel"
import { PeoplePanel } from "@/components/asset-finance/PeoplePanel"
import { DocumentsPanel } from "@/components/asset-finance/DocumentsPanel"
import { FinancialsEvidencePanel } from "@/components/asset-finance/FinancialsEvidencePanel"
import { EntityRecordsTables } from "@/components/asset-finance/EntityRecordsTables"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { hasMinRole } from "@/lib/auth-guards"
import { ScreeningPanel } from "@/components/clients/ScreeningPanel"
import {
  loadEntityCore,
  loadEntityDocuments,
  loadEntityPeople,
  loadEntityRecords,
} from "@/lib/asset-finance/entity-detail"
import { FINANCIALS_EVIDENCE_TYPES, STAFF_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenantId, canManage, user } = await requireAssetFinanceStaffPage()
  const { id } = await params
  const entity = await loadEntityCore(tenantId, id)
  if (!entity) notFound()
  const [people, documents, records] = await Promise.all([
    loadEntityPeople(tenantId, id),
    loadEntityDocuments(tenantId, id),
    loadEntityRecords(tenantId, id),
  ])
  const eligibleEvidence = documents.filter((d) => d.verifiedAt && FINANCIALS_EVIDENCE_TYPES.includes(d.docType))

  return (
    <>
      <Header
        title={entity.legalName}
        subtitle={`${ENTITY_TYPE_LABELS[entity.type]} · ${entity.registrationNumber}`}
        breadcrumbs={[
          { label: "Asset Finance" },
          { label: "Entities", href: "/asset-finance/entities" },
          { label: entity.legalName },
        ]}
      />
      <div className="space-y-5 p-4 lg:p-8">
        <EntityDetailsPanel entity={entity} canManage={canManage} />
        {hasMinRole(user.role, "CREDIT_OFFICER") && (
          <div className="rounded-lg border border-[var(--cf-border-subtle)] p-4">
            <ScreeningPanel endpoint={`/api/asset-finance/entities/${id}/screening`} />
          </div>
        )}
        <PeoplePanel entityId={id} people={people} canManage={canManage} />
        <DocumentsPanel
          apiBase={`/api/asset-finance/entities/${id}/documents`}
          documents={documents}
          uploadTypes={STAFF_UPLOAD_DOC_TYPES}
          canUpload={canManage}
          canManage={canManage}
        />
        <FinancialsEvidencePanel
          entityId={id}
          hasFigures={entity.annualTurnover !== null || entity.totalAssetValue !== null}
          eligible={eligibleEvidence}
          selectedIds={entity.financialsEvidenceIds}
          canManage={canManage}
        />
        <EntityRecordsTables records={records} />
      </div>
    </>
  )
}
