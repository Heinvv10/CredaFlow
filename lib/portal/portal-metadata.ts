import type { Metadata } from "next"
import { findLenderIdentity, getLenderBrandName } from "@/lib/config/identity"

/**
 * The browser tab for client portal pages: "Client portal — <lender>", and a
 * page's own title in front of it. Without it every portal tab read the root
 * layout's "Client and staff workspace" (Fair Score audit 2026-10-16).
 */
export async function portalMetadata(tenantId: string | null | undefined): Promise<Metadata> {
  if (!tenantId) return { title: "Client portal" }
  const identity = await findLenderIdentity(tenantId)
  const lender = identity?.tradingName ?? await getLenderBrandName(tenantId)
  const portal = `Client portal — ${lender}`
  return { title: { default: portal, template: `%s · ${portal}` } }
}
