import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { listNotifications, unreadNotificationCount } from "@/lib/notifications/bell"

/**
 * The signed-in user's bell items + unread count.
 *
 * READONLY: every staff role has a bell, and the query is bounded to the
 * caller's own rows regardless of role — `userId` comes from the session, not
 * from a parameter, so there is no id to tamper with.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const [items, unread] = await Promise.all([
      listNotifications({ tenantId: tenant.id, userId: guard.user.id }),
      unreadNotificationCount({ tenantId: tenant.id, userId: guard.user.id }),
    ])
    return NextResponse.json({ items, unread })
  })
}
