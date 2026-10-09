import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { beneficiaryAuditValue } from "../audit-value"

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; beneficiaryId: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id, beneficiaryId } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      // Verify policy belongs to tenant before operating on beneficiary
      const policy = await prisma.insurancePolicy.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true },
      })
      if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })

      // Verify beneficiary belongs to this policy
      const beneficiary = await prisma.insuranceBeneficiary.findFirst({
        where: { id: beneficiaryId, policyId: id },
      })
      if (!beneficiary) return NextResponse.json({ error: "Beneficiary not found" }, { status: 404 })

      await prisma.insuranceBeneficiary.delete({ where: { id: beneficiaryId } })

      // Irreversible: this removes the person who would be paid out on a death
      // claim. The prior row goes in oldValue — minus the idNumber and
      // dateOfBirth, see beneficiaryAuditValue — because after this write the
      // audit row is the only evidence the beneficiary was ever on the policy.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_BENEFICIARY_REMOVED,
        entity: "InsuranceBeneficiary",
        entityId: beneficiaryId,
        oldValue: beneficiaryAuditValue(beneficiary),
        newValue: { deleted: true },
      })

      return NextResponse.json({ ok: true })
    })
  } catch (error) {
    console.error("Failed to delete beneficiary:", error)
    return NextResponse.json({ error: "Failed to delete beneficiary" }, { status: 500 })
  }
}
