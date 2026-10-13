import { notFound } from "next/navigation"
import { BackLink } from "@/components/nav/BackLink"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { PortalContractDocuments } from "@/components/asset-finance/PortalContractDocuments"
import { PortalContractSchedule } from "@/components/asset-finance/PortalContractSchedule"
import { requirePortalEntityPage } from "@/lib/asset-finance/portal-page"
import { loadPortalContract, type PortalContractView } from "@/lib/asset-finance/portal-contract"
import { ASSET_CLASS_LABELS } from "@/lib/asset-finance/asset-labels"
import { RATE_BASIS_LABELS, ratePercent } from "@/lib/asset-finance/deal-labels"
import { statusLabel } from "@/lib/asset-finance/labels"
import { formatDate, formatZAR } from "@/lib/utils"

type Params = { params: Promise<{ entityId: string; loanId: string }> }

function rateText(rate: PortalContractView["rate"]): string {
  if (!rate) return "Not recorded"
  if (rate.basis === "FIXED") return `Fixed ${ratePercent(rate.currentRate)}`
  const margin = rate.margin === null ? "" : ` ${Number(rate.margin) < 0 ? "−" : "+"} ${ratePercent(String(Math.abs(Number(rate.margin))))}`
  return `${RATE_BASIS_LABELS[rate.basis]}${margin} (now ${ratePercent(rate.currentRate)})`
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="font-semibold text-[var(--cf-text)]">{value}</dd>
      {sub && <dd className="text-xs text-[var(--cf-text-muted)]">{sub}</dd>}
    </div>
  )
}

export default async function PortalContractPage({ params }: Params) {
  const { entityId, loanId } = await params
  // 404 unless this client is an active director, trustee or authorised signatory
  // of the entity; the loader answers null for a loan that is not this entity's.
  const { tenantId, clientId } = await requirePortalEntityPage(entityId)
  const view = await loadPortalContract(tenantId, entityId, loanId, clientId)
  if (!view) notFound()
  const asset = view.asset

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-6">
      <BackLink href={`/portal/business/${entityId}`} label={`Back to ${view.entity.legalName}`} />
      <DataPanel
        title={`Contract ${view.loan.reference}`}
        description={`${statusLabel(view.loan.contractType)} · ${view.entity.legalName}`}
        actions={<StatusPill tone={view.arrears.amountCents > 0 ? "danger" : "success"}>{statusLabel(view.loan.status)}</StatusPill>}
      >
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
          <Figure
            label="Asset"
            value={asset ? `${asset.year} ${asset.make} ${asset.model}` : "Not recorded"}
            sub={asset ? `${ASSET_CLASS_LABELS[asset.assetClass]} · serial ${asset.serialNumber}${asset.registrationNumber ? ` · reg ${asset.registrationNumber}` : ""}` : undefined}
          />
          <Figure label="Rate" value={rateText(view.rate)} />
          <Figure label="Term" value={`${formatDate(view.startDate)} – ${formatDate(view.maturityDate)}`} sub="Start to maturity" />
          <Figure label="Balloon" value={view.balloonCents > 0 ? formatZAR(view.balloonCents) : "None"} sub={view.balloonCents > 0 ? "Payable with the final instalment" : undefined} />
          <Figure
            label="Outstanding balance"
            value={formatZAR(view.outstandingCents)}
            sub={view.chargeLines.map((l) => `${l.label} ${formatZAR(l.amount)}`).join(" · ") || undefined}
          />
          <Figure
            label="Arrears"
            value={view.arrears.amountCents > 0 ? formatZAR(view.arrears.amountCents) : "None"}
            sub={view.arrears.days > 0 ? `${view.arrears.days} days overdue` : undefined}
          />
          <Figure
            label="Next payment"
            value={view.nextPayment ? formatZAR(view.nextPayment.amountCents) : "None scheduled"}
            sub={view.nextPayment ? `Due ${formatDate(view.nextPayment.dueDate)}` : undefined}
          />
        </dl>
      </DataPanel>
      <DataPanel title="Documents" description="Statement, tax invoice and the signed contract documents">
        <PortalContractDocuments view={view} />
      </DataPanel>
      <DataPanel title="Repayment schedule" density="compact">
        <PortalContractSchedule rows={view.schedule} />
      </DataPanel>
    </div>
  )
}
