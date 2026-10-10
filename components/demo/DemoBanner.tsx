import { connection } from "next/server"
import { getLenderBrandName, LenderIdentityError } from "@/lib/config/identity"
import { demoBannerText, isDemoMode } from "@/lib/config/demo-mode"
import { getResolvedTenantId } from "@/lib/tenant"

// Banner height, published as --cf-demo-banner-h (0 in app/globals.css) for the
// shell chrome that offsets itself below it. html:root outranks the :root default.
const BANNER_HEIGHT_CSS =
  "html:root{--cf-demo-banner-h:3rem}@media (min-width:640px){html:root{--cf-demo-banner-h:2rem}}"

// Rendered from the root layout so every surface (website, portal, staff app,
// login pages) carries it. Not dismissable by design. Colours are the warning
// token on the on-brand token: both flip with the light theme and clear 4.5:1.
export async function DemoBanner() {
  // DEMO_MODE is runtime env and one image runs with and without it, so the
  // read must happen per request, never at build time on a prerendered route.
  await connection()
  if (!isDemoMode()) return null
  let brandName: string | null = null
  try {
    brandName = await getLenderBrandName(await getResolvedTenantId())
  } catch (e) {
    // An unconfigured lender gets the generic wording. Anything else is a real
    // fault: record it, but a banner must not take every page down with it.
    if (!(e instanceof LenderIdentityError)) {
      console.error("[demo-banner] lender brand lookup failed:", e)
    }
  }
  return (
    <>
      <style>{BANNER_HEIGHT_CSS}</style>
      <div
        role="note"
        data-demo-banner
        className="sticky top-0 z-[100] flex h-[var(--cf-demo-banner-h)] items-center justify-center bg-[var(--cf-warning)] px-3 text-center text-xs font-semibold leading-4 text-[var(--cf-on-brand)]"
      >
        {demoBannerText(brandName)}
      </div>
    </>
  )
}
