"use client"

import { useRouter } from "next/navigation"
import type { EntityDocumentType } from "@prisma/client"
import { DocumentUploadForm } from "@/components/asset-finance/DocumentUploadForm"

/**
 * Uploads payout evidence filed on this deal, through the deal-scoped route:
 * it serves entity and individual lessees alike and validates against the list
 * the dropdown is built from. The URL names the deal, so no dealId field is sent.
 */
export function EvidenceUpload(props: { dealId: string; docTypes: readonly EntityDocumentType[] }) {
  const router = useRouter()
  return (
    <DocumentUploadForm
      apiBase={`/api/asset-finance/deals/${props.dealId}/documents`}
      docTypes={props.docTypes}
      onUploaded={() => router.refresh()}
    />
  )
}
