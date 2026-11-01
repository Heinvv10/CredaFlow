import { NextResponse, type NextRequest } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { issueArrearsLetter } from "@/lib/non-nca-documents/arrears-letter"

type RouteCtx = { params: Promise<{ id: string }> }

/** Issue and send an arrears letter on a key-facts loan, from the lender's approved template. The collections roles, as a Section 129 notice has. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "act_on_collections")) {
    return NextResponse.json({ error: "Your role cannot act on collections." }, { status: 403 })
  }
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    try {
      const result = await issueArrearsLetter({ tenantId: tenant.id, loanId: id, staff: { id: guard.user.id, email: guard.user.email ?? "" }, ipAddress: recordedCallerIp(req) ?? undefined })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      if (error instanceof TemplateUnavailableError) {
        return NextResponse.json({ error: `${error.message}. The lender's legal team publishes it under Settings, Documents.` }, { status: 409 })
      }
      if (error instanceof MissingTokenError) return NextResponse.json({ error: error.message, missing: error.missing }, { status: 422 })
      throw error
    }
  })
}
