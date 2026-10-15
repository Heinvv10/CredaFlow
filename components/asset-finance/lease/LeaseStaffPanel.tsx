import { DataPanel } from "@/components/app-shell/DataPanel"
import { prisma } from "@/lib/prisma"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { canRecordReading, canSubmitClaim } from "@/lib/asset-finance/lease-staff-actions"
import type { ClaimOptions } from "./ClaimSubmitForm"
import { LeaseEndOfTermPanel } from "./LeaseEndOfTermPanel"
import { LeaseFundPanel } from "./LeaseFundPanel"
import { LeaseReadingsPanel } from "./LeaseReadingsPanel"
import { LeaseRentalsTable } from "./LeaseRentalsTable"
import { LeaseTerminationPanel } from "./LeaseTerminationPanel"
import { loadLeaseStaffData, type LeaseStaffData } from "./lease-staff-data"

/**
 * The lease panels of the staff loan page, for an operating or
 * full-maintenance lease only: the terms, the rentals and their tax invoices,
 * the maintenance fund and claims (full maintenance), meter readings and
 * usage, the end-of-term workflow and early-termination quotes. Server
 * component: it reads through prisma for the tenant; the steps are small
 * client components posting to app/api/asset-finance/leases/[loanId]/.
 * `canManage` / `canDecide` are manage_asset_finance / decide_asset_finance.
 */

const TIMING_LABELS: Record<string, string> = { ADVANCE: "In advance", ARREARS: "In arrears" }

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

/** Providers, filed documents and readings a claim can name; read only when the claim form shows. */
async function claimOptions(tenantId: string, data: LeaseStaffData): Promise<ClaimOptions> {
  const [suppliers, documents] = await Promise.all([
    prisma.supplier.findMany({
      where: { tenantId, active: true, bankAccounts: { some: { status: "APPROVED" } } }, orderBy: { name: "asc" }, select: { id: true, name: true },
    }),
    prisma.entityDocument.findMany({
      where: { tenantId, dealId: data.deal.id, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, fileName: true, createdAt: true },
    }),
  ])
  const unit = data.deal.usage?.unit === "KM" ? "km" : "hours"
  return {
    suppliers: suppliers.map((s) => ({ id: s.id, label: s.name })),
    documents: documents.map((d) => ({ id: d.id, label: d.fileName })),
    readings: data.readings.map((r) => ({ id: r.id, label: `${formatIsoDate(r.readingDate)} · ${r.value.toLocaleString("en-ZA")} ${unit}` })),
  }
}

export async function LeaseStaffPanel(props: { tenantId: string; loanId: string; userId: string; canManage: boolean; canDecide: boolean }) {
  const { tenantId, userId, canManage, canDecide } = props
  const data = await loadLeaseStaffData(tenantId, props.loanId)
  if (!data) return null
  const fml = data.contractType === "FULL_MAINTENANCE_LEASE"
  const { fund, deal } = data
  const submit = fund !== null && canSubmitClaim({ loanStatus: data.loanStatus, today: data.today, leaseEndDate: fund.leaseEndDate, fundSettled: fund.settledAt !== null, canManage })
  const options: ClaimOptions = submit ? await claimOptions(tenantId, data) : { suppliers: [], documents: [], readings: [] }
  const recordReading = canRecordReading({ loanStatus: data.loanStatus, unitContracted: deal.usage !== null, endStatus: data.endOfTerm?.status ?? null, canManage })

  return (
    <div className="space-y-6">
      <DataPanel title={fml ? "Full-maintenance lease" : "Operating lease"} description="Not a credit agreement: the lessee pays rentals and the asset comes back." density="loose">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Item label="Rentals paid">{TIMING_LABELS[deal.rentalTiming] ?? deal.rentalTiming}</Item>
          <Item label="Rental escalation">{(Number(deal.escalationRate) * 100).toFixed(2)}% a year</Item>
          <Item label="Last rental due">{formatIsoDate(data.maturityDate)}</Item>
          <Item label="Early-termination penalty">{(Number(deal.earlyTerminationPenaltyRate) * 100).toFixed(2)}%</Item>
          {deal.usage && <Item label="Contracted usage">{deal.usage.allowancePerYear.toLocaleString("en-ZA")} {deal.usage.unit === "HOURS" ? "hours" : "km"} a year, excess {formatMoney(deal.usage.excessRateCents)}</Item>}
          {data.cpaApplies !== null && <Item label="Consumer Protection Act">{data.cpaApplies ? "Applies to the lessee" : "Does not apply"}</Item>}
        </dl>
      </DataPanel>
      <LeaseRentalsTable rentals={data.rentals} maintenance={fml} today={data.today} />
      {fund && (
        <LeaseFundPanel loanId={data.loanId} loanStatus={data.loanStatus} today={data.today} fund={fund} userId={userId}
          canManage={canManage} canDecide={canDecide} options={options} />
      )}
      {deal.usage && <LeaseReadingsPanel data={data} usage={deal.usage} canRecord={recordReading} />}
      <LeaseEndOfTermPanel tenantId={tenantId} data={data} canManage={canManage} canDecide={canDecide} />
      <LeaseTerminationPanel data={data} canManage={canManage} canDecide={canDecide} />
    </div>
  )
}
