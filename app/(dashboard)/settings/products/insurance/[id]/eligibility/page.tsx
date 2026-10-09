import { EligibilityRulesManager } from "@/components/insurance/config/EligibilityRulesManager"
import { ConfigPageFrame, loadInsuranceConfigContext } from "../config-page-context"

export const metadata = {
  title: "Eligibility rules — Insurance product",
}

export default async function InsuranceEligibilityPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { product, canWrite, featureIms } = await loadInsuranceConfigContext(id)

  return (
    <ConfigPageFrame product={product} section="Eligibility rules" featureIms={featureIms}>
      <p className="text-sm text-gray-500 max-w-3xl">
        These are the insurer&apos;s stated acceptance terms, captured as data. Screening a quote
        against them is not underwriting — no decision is made here that the insurer has not already
        specified. A rule scoped to one life type overrides the all-lives rule for that type, and a
        term that is captured but not in force is ignored exactly as if it were absent.
      </p>
      <EligibilityRulesManager productId={product.id} canWrite={canWrite} />
    </ConfigPageFrame>
  )
}
