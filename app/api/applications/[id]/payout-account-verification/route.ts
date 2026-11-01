import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { recordPayoutAccountVerification } from "@/lib/non-nca-documents/payout-account"
import { withTenantContext } from "@/lib/tenant"

/** A staff member confirms the payout account of a key-facts loan: the second person the payout requires (lib/non-nca-documents/payout-account.ts). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const result = await recordPayoutAccountVerification({ tenantId: tenant.id, applicationId: id, user: { id: guard.user.id, email: guard.user.email ?? "" }, note: body?.note })
    return result.ok ? NextResponse.json({ id: result.id }) : NextResponse.json({ error: result.error }, { status: result.status })
  })
}
