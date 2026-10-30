import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole, requireOwnerOrStaff } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { issueLoanDocuments } from "@/lib/non-nca-documents/issue"
import { QuoteUnavailableError } from "@/lib/non-nca-documents/quote"
import { loanDocumentState } from "@/lib/non-nca-documents/state"

type RouteCtx = { params: Promise<{ id: string }> }

/** The standing key facts statement and loan agreement of an application (its borrower, or staff). */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { clientId: true } })
    if (!application?.clientId) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    const state = await loanDocumentState(tenant.id, id)
    return NextResponse.json(state?.keyFacts ?? { error: "This application has no key facts statement" }, { status: state?.keyFacts ? 200 : 409 })
  })
}

/**
 * Issue (or re-issue) the key facts statement and the loan agreement from the
 * lender's current approved templates. A credit officer's action; refused for an
 * application that is not approved and unsigned, or whose template is missing,
 * unapproved or has an unresolved token.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    try {
      const result = await issueLoanDocuments({
        tenantId: tenant.id, applicationId: id, staff: { id: guard.user.id, email: guard.user.email ?? "" }, ipAddress: recordedCallerIp(req) ?? undefined,
      })
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
      return NextResponse.json({ issued: result.issued }, { status: 201 })
    } catch (error) {
      if (error instanceof TemplateUnavailableError) {
        return NextResponse.json({ error: `${error.message}. The lender's legal team publishes it under Settings, Documents.` }, { status: 409 })
      }
      if (error instanceof MissingTokenError) return NextResponse.json({ error: error.message, missing: error.missing }, { status: 422 })
      if (error instanceof QuoteUnavailableError) return NextResponse.json({ error: error.message }, { status: 409 })
      throw error
    }
  })
}
