import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { prisma } from "@/lib/prisma"
import { formatMoney } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { CLOSED_DEAL_STATUSES } from "@/lib/asset-finance/deal-create"
import { ASSET_FINANCE_PRODUCT_WHERE } from "@/lib/asset-finance/deal-products"
import { defaultUsageUnit } from "@/lib/asset-finance/lease-input"
import { DealCreateForm, type DealFormOptions } from "./DealCreateForm"

export default async function NewDealPage() {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  if (!canManage) notFound()

  const [entities, clients, assets, suppliers, products] = await Promise.all([
    prisma.businessEntity.findMany({ where: { tenantId }, orderBy: { legalName: "asc" }, select: { id: true, legalName: true } }),
    prisma.client.findMany({ where: { tenantId }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], select: { id: true, firstName: true, lastName: true, reference: true } }),
    // Unreleased and on no open deal: the create route refuses the rest.
    prisma.financedAsset.findMany({
      where: { tenantId, releasedAt: null, deals: { none: { status: { notIn: [...CLOSED_DEAL_STATUSES] } } } },
      orderBy: { createdAt: "desc" },
      select: { id: true, assetClass: true, year: true, make: true, model: true, serialNumber: true, cashPriceExclVatCents: true, vatCents: true },
    }),
    prisma.supplier.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // Active ASSET_FINANCE products only; the create route refuses the rest.
    prisma.loanProduct.findMany({
      where: { tenantId, ...ASSET_FINANCE_PRODUCT_WHERE },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ])
  const options: DealFormOptions = {
    entities: entities.map((e) => ({ id: e.id, label: e.legalName })),
    clients: clients.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName} · ${c.reference}` })),
    assets: assets.map((a) => ({
      id: a.id,
      label: `${a.year} ${a.make} ${a.model} · ${a.serialNumber} · ${formatMoney(a.cashPriceExclVatCents + a.vatCents)} incl. VAT`,
      usageUnit: defaultUsageUnit(a.assetClass),
    })),
    suppliers: suppliers.map((s) => ({ id: s.id, label: s.name })),
    products: products.map((p) => ({ id: p.id, label: p.name })),
  }

  return (
    <>
      <Header
        title="New deal"
        subtitle="Instalment sale or lease: structure the deal and check the schedule before you save it"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Deals", href: "/asset-finance/deals" }, { label: "New" }]}
      />
      <div className="p-4 lg:p-8">
        <DealCreateForm options={options} />
      </div>
    </>
  )
}
