import { loadPortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import type { Locale } from "@/lib/i18n/locales"
import { PortalRecoveryCard } from "./PortalRecoveryCard"

/** The recovery card of a borrower's contract page, or nothing when the contract has no recovery. The page has already authorised the borrower for the loan. */
export async function PortalRecoverySection({ tenantId, loanId, locale }: { tenantId: string; loanId: string; locale: Locale }) {
  const view = await loadPortalRecoveryView(tenantId, loanId)
  return view ? <PortalRecoveryCard view={view} locale={locale} /> : null
}
