import { redirect } from "next/navigation"
import { Building2 } from "lucide-react"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { requirePortalAssetFinancePage } from "@/lib/asset-finance/portal-page"
import { loadPortalEntities } from "@/lib/asset-finance/portal-entities"

/** Opens the first business the client may act for; the entity page carries the switcher. */
export default async function PortalBusinessPage() {
  const { tenantId, clientId } = await requirePortalAssetFinancePage()
  const entities = await loadPortalEntities(tenantId, clientId)
  if (entities.length > 0) redirect(`/portal/business/${entities[0].id}`)
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <EmptyState
        icon={Building2}
        title="No business accounts"
        description="You are not a director, trustee or authorised signatory of a business we finance. Contact us if that is wrong."
        action={{ label: "Back to Overview", href: "/portal" }}
      />
    </div>
  )
}
