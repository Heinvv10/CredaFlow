import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { changeRequestErrorResponse } from "@/lib/maker-checker/http"
import { parseLoanChangePayload } from "@/lib/loan-changes/payload"
import { previewChange } from "@/lib/loan-changes/view"
import { withTenantContext } from "@/lib/tenant"

/** What a proposal would do to this loan as it stands. Writes nothing; a refusal comes back as `refusal`. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "propose_loan_change")) return NextResponse.json({ error: "Your role cannot propose a loan change." }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null
    try {
      const payload = parseLoanChangePayload({ ...raw, loanId: id })
      return NextResponse.json(await previewChange(tenant.id, payload))
    } catch (error) {
      return changeRequestErrorResponse(error)
    }
  })
}
