import { loadPortalRecoveryView } from "@/lib/asset-finance/recovery-view"
import { PortalRecoveryCard } from "./PortalRecoveryCard"

/** The recovery card of a borrower's contract page, or nothing when the contract has no recovery. The page has already authorised the borrower for the loan. */
export async function PortalRecoverySection({ tenantId, loanId }: { tenantId: string; loanId: string }) {
  const view = await loadPortalRecoveryView(tenantId, loanId)
  return view ? <PortalRecoveryCard view={view} /> : null
}
