import { getLenderBrandName } from "@/lib/config/identity"
import { demoBannerText, isDemoMode } from "@/lib/config/demo-mode"
import { getResolvedTenantId } from "@/lib/tenant"

// Rendered from the root layout so every surface (website, portal, staff app,
// login pages) carries it. Not dismissable by design. Colours are the warning
// token on the on-brand token: both flip with the light theme and clear 4.5:1.
export async function DemoBanner() {
  if (!isDemoMode()) return null
  let brandName: string | null = null
  try {
    brandName = await getLenderBrandName(await getResolvedTenantId())
  } catch {
    // Tenant not resolvable on this host/request: the generic wording is correct.
    brandName = null
  }
  return (
    <div
      role="note"
      data-demo-banner
      className="sticky top-0 z-[100] flex h-12 items-center justify-center bg-[var(--cf-warning)] px-3 text-center text-xs font-semibold leading-4 text-[var(--cf-on-brand)] sm:h-8"
    >
      {demoBannerText(brandName)}
    </div>
  )
}
