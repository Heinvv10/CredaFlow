import { DataPanel } from "@/components/app-shell/DataPanel"
import { FormError } from "@/components/asset-finance/register-form-controls"
import { LeaseSchedulePreview } from "@/components/asset-finance/lease/LeaseSchedulePreview"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { ratePercent } from "@/lib/asset-finance/deal-labels"
import type { DealDetail } from "@/lib/asset-finance/deal-detail"
import type { DealLeaseSchedule } from "@/lib/asset-finance/lease-schedule"

// The deal page's rentals for an operating or full-maintenance lease: rental
// ex VAT, maintenance, VAT and total per period, the residual the lessee never
// pays. The same figures the create preview and the lease agreement show
// (lib/asset-finance/lease-schedule.ts). No hooks: server-rendered.

export function LeaseScheduleSection({ deal, schedule }: { deal: DealDetail; schedule: DealLeaseSchedule }) {
  const when = schedule.ok ? `${formatIsoDate(schedule.startDate)}${schedule.rate ? ` at ${ratePercent(schedule.rate.annualRate)} a year` : ""}` : ""
  const description = !schedule.ok ? undefined : schedule.prepared
    ? `The contract rentals from ${when}, as the lease agreement prints them`
    : `Indicative from ${when}; the contract rentals are priced from the start date chosen when the documents are prepared`
  return (
    <DataPanel title="Rental schedule" description={description}>
      {schedule.ok ? (
        <LeaseSchedulePreview lease={schedule.schedule} capitalCents={deal.asset.cashPriceExclVatCents}
          residualCents={deal.terms.balloonCents} maintenance={deal.contractType === "FULL_MAINTENANCE_LEASE"} />
      ) : (
        <FormError message={`The rentals cannot be priced: ${schedule.error}`} />
      )}
    </DataPanel>
  )
}
