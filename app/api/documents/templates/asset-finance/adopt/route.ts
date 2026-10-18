import { NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { adoptStarter } from "@/lib/asset-finance/documents/templates/store"
import { storeResponse, templateActor } from "@/lib/asset-finance/documents/templates/route-helpers"

/**
 * Adopt the starter wording of one asset-finance document family as this
 * lender's own draft (one template per variant). Idempotent and audited; an
 * adopted template's wording is never overwritten by the starter.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => ({}))) as { family?: unknown }
    return storeResponse(await adoptStarter(templateActor(guard.user, tenant.id), typeof body.family === "string" ? body.family : ""))
  })
}
