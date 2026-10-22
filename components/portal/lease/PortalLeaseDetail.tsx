import { BackLink } from "@/components/nav/BackLink"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { ASSET_CLASS_LABELS } from "@/lib/asset-finance/asset-labels"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { statusLabel } from "@/lib/asset-finance/labels"
import type { PortalContractDocument } from "@/lib/asset-finance/portal-contract"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"
import { canSubmitReading, endOfTermOffer, terminationActions } from "@/lib/asset-finance/portal-lease-view"
import { LeaseDocuments } from "./LeaseDocuments"
import { LeaseEndOfTermPanel } from "./LeaseEndOfTermPanel"
import { LeaseMaintenanceFund } from "./LeaseMaintenanceFund"
import { LeaseMeterReadingForm } from "./LeaseMeterReadingForm"
import { LeaseOtherCharges } from "./LeaseOtherCharges"
import { LeaseRentalsTable } from "./LeaseRentalsTable"
import { LeaseTerminationPanel } from "./LeaseTerminationPanel"

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="font-semibold text-[var(--cf-text)]">{value}</dd>
      {sub && <dd className="text-xs text-[var(--cf-text-muted)]">{sub}</dd>}
    </div>
  )
}

/**
 * A lease as its lessee sees it: shared by the entity contract page and the
 * sole proprietor's contract page. `view` was read through loadPortalLease,
 * so the lessee is already authorised; `documents` (the entity routes' signed
 * documents) is passed by the entity page only.
 */
export function PortalLeaseDetail({ view, back, documents, extra }: {
  view: PortalLeaseView
  back: { href: string; label: string }
  documents?: PortalContractDocument[]
  /** Panels the page adds after the lease's own (the recovery card). */
  extra?: React.ReactNode
}) {
  const { loan, asset, today } = view
  const status = loan.status
  const termination = terminationActions({
    status, endOfTermStarted: view.endOfTerm.chosen !== null, penaltyConfigured: view.termination.penaltyConfigured,
    quote: view.termination.latestQuote, today,
  })
  const charges = view.defaultCharges
  const offer = endOfTermOffer({ status, lastRentalDate: loan.maturityDate, chosen: view.endOfTerm.chosen !== null, currentValuation: view.endOfTerm.valuation !== null, today })

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-8 md:px-6">
      <BackLink href={back.href} label={back.label} />
      <DataPanel
        title={`Lease ${loan.reference}`}
        description={[statusLabel(loan.contractType), view.entity?.legalName].filter(Boolean).join(" · ")}
        actions={<StatusPill tone={view.overdueInclChargesCents > 0 ? "danger" : "success"}>{statusLabel(status)}</StatusPill>}
      >
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
          <Figure
            label="Asset"
            value={asset ? `${asset.year} ${asset.make} ${asset.model}` : "Not recorded"}
            sub={asset ? `${ASSET_CLASS_LABELS[asset.assetClass]} · serial ${asset.serialNumber}${asset.registrationNumber ? ` · reg ${asset.registrationNumber}` : ""}` : undefined}
          />
          <Figure label="Term" value={`${formatIsoDate(loan.startDate)} – ${formatIsoDate(loan.maturityDate)}`} sub="Commencement to the last rental" />
          <Figure
            label="Next rental"
            value={view.nextRental ? formatMoney(view.nextRental.amountCents) : "None due"}
            sub={view.nextRental ? `Due ${formatIsoDate(view.nextRental.dueDate)}` : undefined}
          />
          <Figure label="Overdue rentals" value={view.arrearsCents > 0 ? formatMoney(view.arrearsCents) : "None"} />
          <Figure
            label="Overdue incl. charges"
            value={view.overdueInclChargesCents > 0 ? formatMoney(view.overdueInclChargesCents) : "None"}
            sub={charges.lines.length > 0 ? `Includes ${charges.lines.map((l) => `${l.label} ${formatMoney(l.amount)}`).join(" · ")}` : undefined}
          />
          {view.fund && <Figure label="Maintenance fund" value={formatMoney(view.fund.balanceCents)} />}
        </dl>
      </DataPanel>
      <DataPanel title="Rentals" description={`${loan.contractType === "FULL_MAINTENANCE_LEASE" ? "Rental and maintenance exclude" : "The rental excludes"} VAT; the total includes it. Each rental has its own tax invoice.`} density="compact">
        <LeaseRentalsTable loanId={loan.id} rentals={view.rentals} maintenance={loan.contractType === "FULL_MAINTENANCE_LEASE"} />
      </DataPanel>
      {(view.otherCharges.length > 0 || charges.outstandingCents > 0) && (
        <DataPanel title="Other charges" description="What the lease owes besides its rentals" density="compact">
          <LeaseOtherCharges loanId={loan.id} charges={view.otherCharges} defaultCharges={charges} />
        </DataPanel>
      )}
      {view.fund && (
        <DataPanel title="Maintenance fund" description="What the maintenance part of your rentals has built up, and the claims made against it">
          <LeaseMaintenanceFund fund={view.fund} />
        </DataPanel>
      )}
      {view.meter && canSubmitReading({ status, usageUnit: view.meter.unit }) && (
        <DataPanel title="Meter reading" description="Your lease has contracted usage: tell us what the meter reads today">
          <LeaseMeterReadingForm loanId={loan.id} today={today} unit={view.meter.unit} latest={view.meter.latest} />
        </DataPanel>
      )}
      {view.meter && view.meter.voided.length > 0 && (
        <DataPanel title="Voided meter readings" description="Readings we found to be wrong: they do not count towards your usage">
          <ul className="space-y-1 text-sm">
            {view.meter.voided.map((r) => (
              <li key={`${r.readingDate}-${r.value}`} className="flex justify-between gap-3">
                <span className="text-[var(--cf-text-muted)] line-through">{r.readingDate} · {r.value.toLocaleString("en-ZA")} {view.meter?.unit === "HOURS" ? "hours" : "km"}</span>
                <span className="text-[var(--cf-text-secondary)]">Voided {r.voidedOn}</span>
              </li>
            ))}
          </ul>
        </DataPanel>
      )}
      {(termination.canRequest || termination.state !== "NONE") && (
        <DataPanel title="End the lease early" description={view.termination.cpaApplies ? "Cancel on 20 business days notice; the charge is assessed separately" : "Ask for a quote and, if it suits you, accept it"}>
          <LeaseTerminationPanel cpa={view.termination.cpaApplies} loanId={loan.id} quote={view.termination.latestQuote} actions={termination} />
        </DataPanel>
      )}
      {offer.kind !== "closed" && (
        <DataPanel title="End of the lease" description="Return the asset, extend the lease or buy the asset">
          <LeaseEndOfTermPanel loanId={loan.id} offer={offer} chosen={view.endOfTerm.chosen} valuation={view.endOfTerm.valuation} expiryNotice={view.endOfTerm.expiryNotice} />
        </DataPanel>
      )}
      {documents && (
        <DataPanel title="Documents" description="Statement and the signed contract documents">
          <LeaseDocuments loanId={loan.id} documents={documents} />
        </DataPanel>
      )}
      {extra}
    </div>
  )
}
