import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { issueIndicativeKeyFactsForDraft } from "@/lib/non-nca-documents/pre-submission"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

type RouteCtx = { params: Promise<{ id: string }> }

/** The key facts statement of a staff draft, for the borrower at the branch to read before it is submitted (tender 2.2.4). */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    try {
      const result = await issueIndicativeKeyFactsForDraft({ tenantId: tenant.id, applicationId: id, staff: { id: guard.user.id, email: guard.user.email ?? "" }, ipAddress: recordedCallerIp(req) ?? undefined })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      if (error instanceof TemplateUnavailableError || error instanceof MissingTokenError) {
        return NextResponse.json({ error: `${error.message}. The lender's legal team publishes it under Settings, Documents.` }, { status: 409 })
      }
      throw error
    }
  })
}
