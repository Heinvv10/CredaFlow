import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import PortalForgotPasswordForm from "@/components/auth/PortalForgotPasswordForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Reset password" }

export default async function PortalForgotPasswordPage() {
  const session = await auth()
  if (session?.user) {
    redirect(session.user.role === "CLIENT" ? "/portal" : "/dashboard")
  }
  return <PortalForgotPasswordForm brandName={await getLenderBrandName(await getResolvedTenantId())} />
}
