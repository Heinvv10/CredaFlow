import { DataPanel } from "@/components/app-shell/DataPanel"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { cancellationEvidenceWhere } from "@/lib/asset-finance/borrower-document-scope"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { EvidenceUpload } from "@/app/(dashboard)/asset-finance/deals/[id]/EvidenceUpload"
import { CommercialCancellationForm } from "./CommercialCancellationForm"

export async function CommercialCancellationPanel({ tenantId, loanId, canDecide }: { tenantId: string; loanId: string; canDecide: boolean }) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId, ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" },
    select: { id: true, status: true, entityId: true, clientId: true, startDate: true, assetFinanceDeal: { select: { id: true } }, commercialCancellationEvent: { include: { evidenceDocument: { select: { fileName: true } }, recordedBy: { select: { name: true } } } } } })
  if (!loan) return null
  const cancellation = loan.commercialCancellationEvent
  const documents = canDecide && !cancellation ? await prisma.entityDocument.findMany({ where: cancellationEvidenceWhere(tenantId, loan), orderBy: { createdAt: "desc" }, select: { id: true, fileName: true } }) : []
  return <DataPanel title="Commercial agreement cancellation" description="Record the actual cancellation separately from repossession and a later sale." density="loose">
    {cancellation ? <div className="space-y-2 text-sm text-[var(--cf-text)]"><p>Cancelled {formatIsoDate(isoOfDbDate(cancellation.cancelledOn))}. Future contractual interest stops on this date.</p><p>{cancellation.basis}</p><p className="text-[var(--cf-text-muted)]">Evidence: {cancellation.evidenceDocument.fileName}. Recorded by {cancellation.recordedBy.name}.</p></div>
      : canDecide && ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF"].includes(loan.status)
        ? <><p className="mb-3 text-sm text-[var(--cf-text-muted)]">Upload the cancellation notice or other legal evidence below first, then select it. A cancellation is permanent and is required before completing the asset sale.</p>
          {loan.assetFinanceDeal && <div className="mb-3"><EvidenceUpload dealId={loan.assetFinanceDeal.id} docTypes={["LEGAL_DOCUMENT"]} /></div>}
          <CommercialCancellationForm loanId={loanId} minDate={sastCalendarDate(loan.startDate)} today={sastCalendarDate(new Date())} documents={documents.map((d) => ({ id: d.id, name: d.fileName }))} /></>
        : <p className="text-sm text-[var(--cf-text-muted)]">No evidenced cancellation has been recorded.</p>}
  </DataPanel>
}
