import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { parseResolveAction, resolvePayout } from "@/lib/payouts/resolve"

// Staff actions on a disbursement payout (lib/payouts/resolve.ts):
// { action: "send" } (only a payout never sent), { action: "check" },
// { action: "confirm_paid", note, providerReference? }, { action: "confirm_failed", note }.
// LOAN_ADMIN, the role that disburses; TOTP when the lender requires it.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "act on a payout")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const request = parseResolveAction(read.body)
    if (!request) {
      return NextResponse.json({ error: "action must be send, check, confirm_paid or confirm_failed; a confirmation needs a note of at least 5 characters" }, { status: 400 })
    }
    const out = await resolvePayout(prisma, { tenantId: tenant.id, payoutId: id, request, actor: { id: guard.user.id, email: guard.user.email } })
    return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
  })
}
