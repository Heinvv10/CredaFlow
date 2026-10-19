"use client"

import { useRouter } from "next/navigation"
import type { EntityDocumentType } from "@prisma/client"
import { DocumentUploadForm } from "@/components/asset-finance/DocumentUploadForm"

/**
 * Uploads payout evidence filed on this deal. An entity lessee uses the
 * entity's document route with dealId; an individual lessee has no entity, so
 * the deal-scoped route takes it (it refuses a dealId field: the URL is the deal).
 */
export function EvidenceUpload(props: { entityId: string | null; dealId: string; docTypes: readonly EntityDocumentType[] }) {
  const router = useRouter()
  return props.entityId ? (
    <DocumentUploadForm
      apiBase={`/api/asset-finance/entities/${props.entityId}/documents`}
      docTypes={props.docTypes}
      dealId={props.dealId}
      onUploaded={() => router.refresh()}
    />
  ) : (
    <DocumentUploadForm
      apiBase={`/api/asset-finance/deals/${props.dealId}/documents`}
      docTypes={props.docTypes}
      onUploaded={() => router.refresh()}
    />
  )
}
