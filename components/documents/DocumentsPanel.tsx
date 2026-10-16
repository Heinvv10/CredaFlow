"use client"

import { useState } from "react"
import { DocumentsTab } from "./DocumentsTab"
import type { SelfieAlternatives, SignedAgreementReturn } from "./UploadDialog"
import { GenerateDocumentPanel, type CustomTemplateOption } from "./GenerateDocumentPanel"

interface Props {
  clientId: string
  popiaConsentGiven: boolean
  customTemplates: CustomTemplateOption[]
  selfieAlternatives?: SelfieAlternatives
  signedAgreementReturn?: SignedAgreementReturn
  /** View and list only: no generate, request-signature or document write controls. */
  readOnly?: boolean
}

/**
 * Documents tab content for the client detail page — the "Generate document"
 * control (Task 18) above the existing upload/verify `DocumentsTab`. Both are
 * independent client components with their own fetch-on-mount state, so a
 * `refreshKey` bumped on successful generation is used as part of
 * `DocumentsTab`'s React `key` to force a remount (and therefore a re-fetch of
 * the client's document list) rather than reaching into its internal state.
 *
 * The key includes `clientId` as well, and that part is load-bearing.
 * `DocumentsTab` holds fetched documents and signing packets in state, and both
 * of its fetches leave the PREVIOUS state in place when a request fails — which
 * is correct for a transient error on one client. But this page is a `[id]`
 * segment: React reconciles a client component by type and position, so moving
 * between two clients without a key change reuses the same instance and its
 * state. A failed refetch for client B would then leave client A's documents
 * AND client A's signing-packet card — captioned as signed evidence, with a
 * working download link — rendered under client B's name. On a lender that is a
 * cross-client disclosure, not a cosmetic staleness.
 *
 * Keying by client makes it structurally impossible rather than relying on
 * Next's reconciliation happening to remount. Not reproduced live (no in-app
 * link goes client→client today), so this is hardening against a reachable
 * shape, not a fixed sighting.
 */
export function DocumentsPanel({ clientId, popiaConsentGiven, customTemplates, selfieAlternatives, signedAgreementReturn, readOnly = false }: Props) {
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="space-y-6">
      {!readOnly && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <GenerateDocumentPanel
            clientId={clientId}
            templates={customTemplates}
            onGenerated={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}
      <div className="bg-white rounded-lg shadow-sm p-6">
        <DocumentsTab
          key={`${clientId}:${refreshKey}`}
          clientId={clientId}
          popiaConsentGiven={popiaConsentGiven}
          selfieAlternatives={selfieAlternatives}
          signedAgreementReturn={signedAgreementReturn}
          readOnly={readOnly}
        />
      </div>
    </div>
  )
}
