import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Forgot password" }

export default async function ForgotPasswordPage() {
  return <ForgotPasswordForm brandName={await getLenderBrandName(await getResolvedTenantId())} />
}
