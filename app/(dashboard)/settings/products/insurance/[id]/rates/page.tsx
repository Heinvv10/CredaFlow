import { RateTablesManager } from "@/components/insurance/config/RateTablesManager"
import { ConfigPageFrame, loadInsuranceConfigContext } from "../config-page-context"

export const metadata = {
  title: "Rate card — Insurance product",
}

export default async function InsuranceRateTablesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { product, canWrite, featureIms } = await loadInsuranceConfigContext(id)

  return (
    <ConfigPageFrame product={product} section="Rate card" featureIms={featureIms}>
      <p className="text-sm text-gray-500 max-w-3xl">
        A rate card is versioned. Rows are entered on a DRAFT; activating it retires whatever this
        product currently sells on, in one transaction, and policies already in force keep the rate
        they were sold at. A card that leaves an age unpriced stores and activates without complaint
        and fails at quote time, so the grid below marks every hole.
      </p>
      <RateTablesManager productId={product.id} productName={product.name} canWrite={canWrite} />
    </ConfigPageFrame>
  )
}
