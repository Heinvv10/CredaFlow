import { NextRequest, NextResponse } from "next/server"
import { getTenantFromRequest } from "@/lib/tenant"
import { dealerCrossSiteRefusal, dealerNotFound } from "@/lib/dealer/guards"
import { readJsonBody, refusalResponse } from "@/lib/dealer/http"
import { setDealerPassword } from "@/lib/dealer/password-links"

/**
 * Public: a dealer user sets a password with the one-time link's token (the
 * token is the credential). Bound to the lender the dealer host resolves;
 * single use; audited DEALER_USER_PASSWORD_SET (lib/dealer/password-links.ts).
 */
export async function POST(req: NextRequest) {
  const crossSite = dealerCrossSiteRefusal(req)
  if (crossSite) return crossSite
  const tenant = await getTenantFromRequest(req)
  if (!tenant) return dealerNotFound()
  const body = (await readJsonBody(req)) as { token?: unknown; password?: unknown } | null
  const result = await setDealerPassword({ tenantId: tenant.id, token: body?.token, password: body?.password })
  if (result.kind === "refused") return refusalResponse(result)
  return NextResponse.json({ ok: true })
}
