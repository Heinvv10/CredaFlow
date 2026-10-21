import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { dealStatusLabel } from "@/lib/asset-finance/deal-labels"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ASSET_CLASS_LABELS, VALUATION_SOURCE_LABELS, assetBookStatus } from "@/lib/asset-finance/asset-labels"
import { ValuationForm } from "./ValuationForm"
import { AssetReadinessForm } from "./AssetReadinessForm"
import { TrackerDevicesPanel } from "@/components/asset-finance/telematics/TrackerDevicesPanel"
import { assetTrackerDevices } from "@/lib/telematics/devices"
import { getTelematicsProvider, registeredTelematicsProviderIds } from "@/lib/telematics/registry"
import { GuideValuePanel } from "@/components/asset-finance/valuation-guides/GuideValuePanel"
import { loadGuidePanel } from "@/lib/valuation-guides/guide-panel"

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm text-[var(--cf-text)]">{value ?? "—"}</dd>
    </div>
  )
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const { id } = await params
  const asset = await prisma.financedAsset.findFirst({
    where: { id, tenantId },
    include: {
      valuations: { orderBy: [{ valuedOn: "desc" }, { createdAt: "desc" }] },
      deals: { select: { id: true, status: true } },
    },
  })
  if (!asset) notFound()
  const devices = await assetTrackerDevices(tenantId, asset.id)
  const providers = registeredTelematicsProviderIds().map((key) => ({ id: key, label: getTelematicsProvider(key)?.label ?? key }))
  const guide = await loadGuidePanel(tenantId, asset.id, null)

  const title = `${asset.year} ${asset.make} ${asset.model}`
  const money = (cents: number | null) => (cents === null ? null : formatMoney(cents))
  const count = (value: number | null) => (value === null ? null : value.toLocaleString("en-ZA"))

  return (
    <>
      <Header
        title={title}
        subtitle={`${ASSET_CLASS_LABELS[asset.assetClass]} · serial ${asset.serialNumber}`}
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Assets", href: "/asset-finance/assets" }, { label: title }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        <DataPanel title="Asset" density="loose">
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Detail label="Serial number / PIN" value={<span className="font-mono">{asset.serialNumber}</span>} />
            <Detail label="VIN" value={asset.vin && <span className="font-mono">{asset.vin}</span>} />
            <Detail label="Engine number" value={asset.engineNumber} />
            <Detail label="Registration" value={asset.registrationNumber} />
            <Detail label="Hours" value={count(asset.hours)} />
            <Detail label="Odometer (km)" value={count(asset.odometerKm)} />
            <Detail label="Cash price excl. VAT" value={money(asset.cashPriceExclVatCents)} />
            <Detail label="VAT" value={money(asset.vatCents)} />
            <Detail label="Residual" value={money(asset.residualCents)} />
            <Detail label="eNaTIS titleholder" value={asset.natisTitleholder} />
            <Detail label="eNaTIS owner" value={asset.natisOwner} />
            <Detail label="Tracker" value={asset.trackerProvider && `${asset.trackerProvider}${asset.trackerId ? ` · ${asset.trackerId}` : ""}`} />
            <Detail label="Insurance" value={asset.insurer && `${asset.insurer}${asset.policyNumber ? ` · ${asset.policyNumber}` : ""}`} />
            <Detail label="Lender noted on policy" value={asset.lenderNotedConfirmed ? "Confirmed" : "Not confirmed"} />
            <Detail label="Book status" value={assetBookStatus({ releasedAt: asset.releasedAt && formatDate(asset.releasedAt), deals: asset.deals })} />
            <Detail label="Deals" value={asset.deals.length === 0 ? "None" : asset.deals.map((d) => dealStatusLabel(d.status)).join(", ")} />
            <Detail label="Registered" value={formatDate(asset.createdAt)} />
          </dl>
        </DataPanel>

        {canManage && (
          <AssetReadinessForm assetId={asset.id} initial={{
            natisTitleholder: asset.natisTitleholder,
            natisOwner: asset.natisOwner,
            trackerProvider: asset.trackerProvider,
            trackerId: asset.trackerId,
            insurer: asset.insurer,
            policyNumber: asset.policyNumber,
            lenderNotedConfirmed: asset.lenderNotedConfirmed,
          }} />
        )}

        <TrackerDevicesPanel assetId={asset.id} devices={devices} canManage={canManage} providers={providers} />
        {guide && <GuideValuePanel assetId={asset.id} data={guide} canManage={canManage} />}

        <DataPanel title="Valuations" density="loose">
          {asset.valuations.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No valuations recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Valued on</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Valuer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Report</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {asset.valuations.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{formatDate(isoOfDbDate(v.valuedOn))}</TableCell>
                    <TableCell>{VALUATION_SOURCE_LABELS[v.source]}</TableCell>
                    <TableCell>{v.valuerName}</TableCell>
                    <TableCell className="text-right">{formatMoney(v.amountCents)}</TableCell>
                    <TableCell className="font-mono text-xs">{v.documentId ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {canManage && <ValuationForm assetId={asset.id} />}
        </DataPanel>
      </div>
    </>
  )
}
