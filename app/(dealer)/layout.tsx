import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

// The dealer portal (DEALER_APP_HOST only: lib/proxy/dealer-host.ts), in the
// colours of the lender the host resolves. Signed-in pages are gated by
// app/(dealer)/dealer/(signed-in)/layout.tsx and each page's requireDealerPage.
export const dynamic = "force-dynamic"

export default async function DealerRootLayout({ children }: { children: React.ReactNode }) {
  const config = await getTenantConfig(await getResolvedTenantId())
  return <TenantThemeProvider config={config}>{children}</TenantThemeProvider>
}
