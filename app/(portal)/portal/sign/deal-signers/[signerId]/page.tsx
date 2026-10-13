import { notFound } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { requirePortalAssetFinancePage } from "@/lib/asset-finance/portal-page"
import { DEAL_DOCUMENT_LABELS, SIGNER_STATE_LABELS, signerState } from "@/lib/asset-finance/signing"
import { DealSignClient } from "./DealSignClient"

/**
 * Read and e-sign ONE deal document. Keyed by the signer row and the session
 * client: a surety with no authority over the entity reaches their own
 * suretyship here and nothing else; any other row is a 404.
 */
export default async function DealSignerPage({ params }: { params: Promise<{ signerId: string }> }) {
  const { signerId } = await params
  const { tenantId, clientId } = await requirePortalAssetFinancePage()
  const signer = await prisma.dealSigner.findFirst({
    where: { id: signerId, tenantId, clientId, deal: { status: { in: ["APPROVED", "CONTRACTED", "BOOKED"] } } },
    select: {
      id: true, document: true, documentSha256: true, method: true, signedAt: true, signatureSha256: true,
      scanDocumentId: true, confirmedById: true, confirmedAt: true,
      deal: { select: { status: true, application: { select: { reference: true } }, entity: { select: { legalName: true } } } },
    },
  })
  if (!signer?.documentSha256) notFound()
  const label = DEAL_DOCUMENT_LABELS[signer.document]
  const state = signerState(signer)
  const documentUrl = `/api/portal/asset-finance/deal-signers/${signer.id}/document`
  const canSign = signer.deal.status === "APPROVED" && signer.method === null

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 md:px-6">
      <DataPanel
        title={label}
        description={`${signer.deal.entity.legalName} · agreement ${signer.deal.application.reference}`}
        actions={<StatusPill tone={canSign ? "warning" : "success"}>{SIGNER_STATE_LABELS[state]}</StatusPill>}
      >
        <div className="flex items-center justify-between gap-3 text-sm">
          <p className="text-[var(--cf-text-secondary)]">Read the whole document before you sign it.</p>
          <a className="text-[var(--cf-brand)] underline" href={documentUrl} target="_blank" rel="noopener noreferrer">Open the PDF in a new tab</a>
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]" style={{ height: "65vh" }}>
          <iframe src={documentUrl} title={label} className="h-full w-full" />
        </div>
      </DataPanel>
      {canSign ? (
        <DealSignClient signerId={signer.id} documentSha256={signer.documentSha256} documentLabel={label} />
      ) : (
        <p className="text-sm text-[var(--cf-text-secondary)]">
          {signer.signedAt ? `You signed this document on ${formatDate(signer.signedAt.toISOString())}.` : "This document is not open for signing here."}
        </p>
      )}
    </div>
  )
}
