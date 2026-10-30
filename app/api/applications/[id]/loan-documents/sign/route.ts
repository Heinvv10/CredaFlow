import { NextResponse, type NextRequest } from "next/server"
import { requireOwnerOrStaff } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { signingOtpChallengeIdFrom } from "@/lib/signing-otp/policy"
import { signKeyFactsAgreement } from "@/lib/non-nca-documents/sign"

type RouteCtx = { params: Promise<{ id: string }> }

/** The borrower signs the loan agreement of a key-facts application. Staff have no path here. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as { agreementDocumentSha256?: unknown; signature?: unknown } | null
    if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    const application = await prisma.loanApplication.findFirst({ where: { id, tenantId: tenant.id }, select: { clientId: true } })
    if (!application?.clientId) return NextResponse.json({ error: "Application not found" }, { status: 404 })
    const access = await requireOwnerOrStaff(application.clientId)
    if (access.error) return access.error
    if (access.type !== "client") return NextResponse.json({ error: "Only the borrower may sign the loan agreement." }, { status: 403 })
    const result = await signKeyFactsAgreement({
      tenantId: tenant.id, applicationId: id, clientId: access.clientId, clientEmail: access.clientEmail, agreementDocumentSha256: body.agreementDocumentSha256,
      signature: body.signature, signingOtpChallengeId: signingOtpChallengeIdFrom(body), ipAddress: recordedCallerIp(req) ?? "unknown",
    })
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.signingOtp ? { signingOtp: result.signingOtp } : {}) }, { status: result.status })
    return NextResponse.json({ success: true, signedAt: result.signedAt })
  })
}
