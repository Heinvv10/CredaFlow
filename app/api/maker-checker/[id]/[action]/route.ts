import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { changeRequestErrorResponse, presentChangeRequest } from "@/lib/maker-checker/http"
import { approve, reject, submit, withdraw } from "@/lib/maker-checker/service"
import { withTenantContext } from "@/lib/tenant"

const ACTIONS = ["submit", "approve", "reject", "withdraw"] as const

/**
 * submit | approve | reject | withdraw one change request. approve and reject
 * take an optional { note } (reject requires it). Permission, maker-is-not-
 * checker and state are enforced by the service and the database, not here.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id, action } = await ctx.params
    if (!(ACTIONS as readonly string[]).includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 404 })
    const body = (await req.json().catch(() => ({}))) as { note?: unknown }
    const note = typeof body.note === "string" ? body.note : ""
    const scope = { tenantId: tenant.id, actor: guard.user, id }
    try {
      const row =
        action === "submit" ? await submit(scope)
        : action === "approve" ? await approve({ ...scope, note })
        : action === "reject" ? await reject({ ...scope, note })
        : await withdraw(scope)
      return NextResponse.json({ request: presentChangeRequest(row, guard.user.id, guard.user.role) })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
