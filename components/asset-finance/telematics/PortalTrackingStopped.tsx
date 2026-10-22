import { prisma } from "@/lib/prisma"
import { findLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatIsoDatePdf } from "@/lib/asset-finance/documents/pdf-layout"
import { TRACKING_STOPPED_TITLE, trackingStoppedParagraphs } from "@/lib/asset-finance/documents/wording/tracking-stopped"

/**
 * The borrower's portal notice that tracking stopped when their agreement
 * ended (SLICE5-FOLLOWUPS.md part T): the same words as the email and the
 * letter, shown once the closure's portal notice is logged.
 */
export async function PortalTrackingStopped({ tenantId, loanId }: { tenantId: string; loanId: string }) {
  const closure = await prisma.trackerClosure.findFirst({
    where: { tenantId, loanId, noticeLoggedAt: { not: null } }, orderBy: { createdAt: "asc" },
    select: { closedAt: true, loan: { select: { reference: true, asset: { select: { make: true, model: true, serialNumber: true } } } } },
  })
  const lender = closure ? await findLenderIdentity(tenantId) : null
  if (!closure || !lender) return null
  const asset = closure.loan.asset
  const paragraphs = trackingStoppedParagraphs({
    lenderName: lender.legalName, loanReference: closure.loan.reference,
    assetDescription: asset ? `${asset.make} ${asset.model} (${asset.serialNumber})` : "financed asset",
    endedOn: formatIsoDatePdf(sastCalendarDate(closure.closedAt)),
  })
  return (
    <section role="status" className="space-y-2 rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
      <h2 className="text-sm font-semibold text-[var(--cf-text)]">{TRACKING_STOPPED_TITLE}</h2>
      {paragraphs.map((p) => <p key={p.slice(0, 40)} className="text-sm text-[var(--cf-text-secondary)]">{p}</p>)}
    </section>
  )
}
