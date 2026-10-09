import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { listStaffForRoster } from "@/lib/inbox/roster"

// Every active staff member is mentionable. Role and isCommsAgent are dropped
// from the response: a mention picker does not need to tell every READONLY
// staffer who holds which role.
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const staff = await listStaffForRoster(tenant.id)
    return NextResponse.json(staff.map((s) => ({ id: s.id, name: s.name, email: s.email })))
  })
}
