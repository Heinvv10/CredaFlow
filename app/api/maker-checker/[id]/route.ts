import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { changeRequestErrorResponse, maySeeKind, presentChangeRequest } from "@/lib/maker-checker/http"
import { getChangeRequest, updateDraft } from "@/lib/maker-checker/service"
import { withTenantContext } from "@/lib/tenant"

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    try {
      const row = await getChangeRequest(tenant.id, (await ctx.params).id)
      // A kind the caller can neither make nor approve is, to them, not there.
      if (!maySeeKind(guard.user.role, row.kind)) return NextResponse.json({ error: "Change request not found" }, { status: 404 })
      return NextResponse.json({ request: presentChangeRequest(row, guard.user.id, guard.user.role) })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}

/** Edits a draft: { title?, payload? }. Only its maker may. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { title?: unknown; payload?: unknown } | null
    if (!body || (body.title !== undefined && typeof body.title !== "string")) {
      return NextResponse.json({ error: "Expected { title?, payload? }" }, { status: 400 })
    }
    try {
      const row = await updateDraft({ tenantId: tenant.id, actor: guard.user, id: (await ctx.params).id, title: body.title as string | undefined, payload: body.payload })
      return NextResponse.json({ request: presentChangeRequest(row, guard.user.id, guard.user.role) })
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
