import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { signingOtpChallengeIdFrom } from "@/lib/signing-otp/policy"
import { signAtBranch } from "@/lib/non-nca-documents/branch-sign"

type RouteCtx = { params: Promise<{ id: string }> }

/** A credit officer records the borrower's own acceptance and signature at a branch, on the borrower's own one-time code. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    const result = await signAtBranch({
      tenantId: tenant.id, applicationId: id, staff: { id: guard.user.id, email: guard.user.email ?? "" }, witnessAttested: body.witnessAttested,
      offerSha256: body.offerSha256, keyFactsSha256: body.keyFactsSha256, agreementDocumentSha256: body.agreementDocumentSha256, signature: body.signature,
      signingOtpChallengeId: signingOtpChallengeIdFrom(body), ipAddress: recordedCallerIp(req) ?? "unknown",
    })
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.signingOtp ? { signingOtp: result.signingOtp } : {}) }, { status: result.status })
    return NextResponse.json({ success: true, signedAt: result.signedAt })
  })
}
