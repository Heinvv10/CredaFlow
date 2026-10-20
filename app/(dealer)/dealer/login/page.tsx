import LoginForm from "@/components/auth/LoginForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

// The dealer portal's sign-in (DEALER_APP_HOST only). A signed-in dealer is
// sent to /dealer by the host gate before this renders.
export const dynamic = "force-dynamic"

export const metadata = { title: "Dealer sign-in" }

export default async function DealerLoginPage() {
  const brandName = await getLenderBrandName(await getResolvedTenantId())
  return <LoginForm variant="dealer" brandName={brandName} crossLink={null} />
}
