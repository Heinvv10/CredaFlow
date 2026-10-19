import { DealerSetPasswordForm } from "@/components/dealer/DealerSetPasswordForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

// The page a dealer user's one-time link opens. The token in the link is the
// credential (POST /api/dealer/set-password); a new link comes from the
// dealer's admin (a new user) or the lender's staff (a reset).
export const dynamic = "force-dynamic"

export const metadata = { title: "Set your password" }

export default async function DealerSetPasswordPage() {
  const brandName = await getLenderBrandName(await getResolvedTenantId())
  return <DealerSetPasswordForm brandName={brandName} />
}
