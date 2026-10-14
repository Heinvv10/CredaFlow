"use client"

import { useRouter } from "next/navigation"
import type { EntityDocumentType } from "@prisma/client"
import { DocumentUploadForm } from "@/components/asset-finance/DocumentUploadForm"

/** Uploads payout evidence filed on this deal (the entity's document route, with dealId). */
export function EvidenceUpload(props: { entityId: string; dealId: string; docTypes: readonly EntityDocumentType[] }) {
  const router = useRouter()
  return (
    <DocumentUploadForm
      apiBase={`/api/asset-finance/entities/${props.entityId}/documents`}
      docTypes={props.docTypes}
      dealId={props.dealId}
      onUploaded={() => router.refresh()}
    />
  )
}
