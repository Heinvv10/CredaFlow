/**
 * The house guard of every staff dealer route under app/api/asset-finance/
 * (dealers/**, dealer-runs/**, dealer-commission/**, deals/[id]/dealer-*):
 * requireApiRole (a staff session; a DEALER or CLIENT session is refused, and
 * a user held at TOTP enrolment gets the enrolment response, as on every
 * staff write) → withTenantContext → requireAssetFinanceEnabled (404 while
 * the module is off) → canDo(permission) (403). The handler gets the staff
 * actor for lib/dealer/* and answers a DealerRefusal with refusalResponse.
 */
import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole, type PermissionKey, type StaffUser } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { DeploymentConfigError, requireDealerBaseUrl } from "@/lib/config/deployment-urls"
import type { StaffActor } from "./actor"

export interface DealerStaffContext {
  tenantId: string
  staff: StaffActor
  user: StaffUser
}

export async function withDealerStaff(
  req: NextRequest,
  permission: PermissionKey,
  handler: (ctx: DealerStaffContext) => Promise<Response>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!canDo(guard.user.role, permission)) {
      return NextResponse.json({ error: `This needs the ${permission} permission` }, { status: 403 })
    }
    const staff: StaffActor = { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }
    return handler({ tenantId: tenant.id, staff, user: guard.user })
  })
}

export { refusalResponse } from "./http"

/** The JSON body, or {} when there is none or it is not an object. */
export async function jsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null)
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/**
 * A set-password link points at the dealer host. Checked before a user or
 * link is written, so a deployment without DEALER_APP_HOST refuses instead
 * of storing a link nobody can be shown.
 */
export function dealerLinkUnavailable(): Response | null {
  try {
    requireDealerBaseUrl()
    return null
  } catch (error) {
    if (!(error instanceof DeploymentConfigError)) throw error
    return NextResponse.json({ error: `No set-password link can be issued: ${error.message}` }, { status: 409 })
  }
}
