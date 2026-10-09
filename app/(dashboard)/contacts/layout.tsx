import { redirect } from "next/navigation"
import { getTenantFeatures } from "@/lib/tenant"

// /contacts is part of the sidebar's "crm" nav group (lib/navigation.ts),
// so it gates on featureCrm, same as /crm.
export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  const { featureCrm } = await getTenantFeatures()
  if (!featureCrm) redirect("/dashboard")

  return <>{children}</>
}
