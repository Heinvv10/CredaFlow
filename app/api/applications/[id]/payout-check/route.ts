import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { keyFactsPayoutCheck } from "@/lib/non-nca-documents/payout-gates"
import { withTenantContext } from "@/lib/tenant"

/** Whether this officer may make the bank transfer of a key-facts loan now: every payout gate, booking nothing. Same role as the payout. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const result = await keyFactsPayoutCheck({ tenantId: tenant.id, applicationId: id, user: { id: guard.user.id, email: guard.user.email ?? "" } })
    return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error, disbursementPrecondition: result.precondition })
  })
}
