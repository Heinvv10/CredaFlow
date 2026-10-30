import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { DelegationError, revokeDelegation } from "@/lib/approval/delegations"
import { withTenantContext } from "@/lib/tenant"

/** Ends a delegation now. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    try {
      await revokeDelegation({ tenantId: tenant.id, actor: guard.user, id })
      return NextResponse.json({ ok: true })
    } catch (error) {
      if (error instanceof DelegationError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
      throw error
    }
  })
}
