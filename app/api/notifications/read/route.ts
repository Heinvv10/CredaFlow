import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { markNotificationsRead } from "@/lib/notifications/bell"

/**
 * Mark the caller's bell items read. Body: `{ ids?: string[] }` — omit `ids`
 * to mark all of them.
 *
 * Not audited via lib/audit.ts: reading your own notification is a UI state
 * change, not a state-changing action on a business record. The event that
 * produced the notification carries the audit trail.
 *
 * markNotificationsRead scopes by userId as well as tenantId. That is the
 * load-bearing part here — `ids` is client-supplied, so without the userId
 * predicate one staff member could mark another's items read.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      // An empty body is a legitimate "mark all read".
      raw = {}
    }
    const body = (raw ?? {}) as { ids?: unknown }

    let ids: string[] | undefined
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some((i) => typeof i !== "string")) {
        return NextResponse.json({ error: "ids must be an array of strings" }, { status: 400 })
      }
      // An explicit empty array means "nothing" — passing it through as
      // undefined would silently escalate to "mark everything read".
      if (body.ids.length === 0) return NextResponse.json({ updated: 0 })
      ids = body.ids as string[]
    }

    const updated = await markNotificationsRead({
      tenantId: tenant.id,
      userId: guard.user.id,
      ids,
    })
    return NextResponse.json({ updated })
  })
}
