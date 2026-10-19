import { DealerPageTitle } from "@/components/dealer/DealerShell"
import { NewDealWizard } from "@/components/dealer/wizard/NewDealWizard"
import type { DealerWizardOptions } from "@/components/dealer/wizard/types"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { listDealerAssets, listDealerEntities, listDealerPeople } from "@/lib/dealer/captures"
import { dealerProductChoices, dealerSupplierChoices } from "@/lib/dealer/deals"
import { formatMoney } from "@/lib/asset-finance/format"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { loadRateOn } from "@/lib/vat/vat-rate"

export const dynamic = "force-dynamic"

// A new draft deal: only the dealer's own captures are offered, and the
// lender's active suppliers and asset-finance products.
export default async function DealerNewDealPage() {
  const actor = await requireDealerPage()
  const [entities, people, assets, suppliers, products, vat] = await Promise.all([
    listDealerEntities(actor), listDealerPeople(actor), listDealerAssets(actor),
    dealerSupplierChoices(actor), dealerProductChoices(actor), loadRateOn(prisma, sastCalendarDate(new Date())),
  ])
  const options: DealerWizardOptions = {
    entities,
    people,
    assets: assets.map((a) => ({ id: a.id, label: `${a.year} ${a.make} ${a.model} · ${a.serialNumber} · ${formatMoney(a.cashPriceExclVatCents + a.vatCents)} incl. VAT` })),
    suppliers: suppliers.suppliers,
    defaultSupplierId: suppliers.defaultSupplierId,
    products: products.map((p) => ({ id: p.id, name: p.name })),
    vatRateTenThousandths: vat.rateTenThousandths,
  }
  return (
    <>
      <DealerPageTitle title="New deal" subtitle="Capture the borrower, their people and the asset, then structure the quote. You add documents and consent on the deal next." />
      <NewDealWizard options={options} />
    </>
  )
}
