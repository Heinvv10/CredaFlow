import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

/**
 * Shown instead of the consumer panels (KYC, affordability, PASQ, mandate,
 * s129) when the borrower is a business entity.
 */
export function EntityBorrowerNotice({
  crumbs,
  reference,
  legalName,
}: {
  crumbs: { label: string; href?: string }[]
  reference: string
  legalName: string | null
}) {
  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <Breadcrumbs className="mb-4" items={[...crumbs, { label: reference }]} />
      <h1 className="text-2xl font-bold text-[var(--cf-text)]">{legalName ?? reference}</h1>
      <p className="mt-2 text-sm text-[var(--cf-text-muted)]">
        Business-entity deal — managed under Asset Finance
      </p>
    </div>
  )
}
