import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { beneficiaryAuditValue } from "./audit-value"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      // Verify policy belongs to tenant before returning beneficiaries
      const policy = await prisma.insurancePolicy.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true },
      })
      if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })

      const beneficiaries = await prisma.insuranceBeneficiary.findMany({
        where: { policyId: id },
        orderBy: { createdAt: "asc" },
      })

      return NextResponse.json(beneficiaries)
    })
  } catch (error) {
    console.error("Failed to fetch beneficiaries:", error)
    return NextResponse.json({ error: "Failed to fetch beneficiaries" }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const body = await req.json() as {
        firstName: string
        lastName: string
        idNumber?: string
        dateOfBirth?: string
        relationship: string
        coverAmount?: number
      }

      if (!body.firstName || !body.lastName || !body.relationship) {
        return NextResponse.json(
          { error: "firstName, lastName and relationship are required" },
          { status: 400 }
        )
      }

      // Verify policy exists and belongs to tenant
      const policy = await prisma.insurancePolicy.findFirst({ where: { id, tenantId: tenant.id } })
      if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })

      const beneficiary = await prisma.insuranceBeneficiary.create({
        data: {
          policyId: id,
          firstName: body.firstName,
          lastName: body.lastName,
          idNumber: body.idNumber ?? null,
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
          relationship: body.relationship,
          coverAmount: body.coverAmount != null ? body.coverAmount : null,
        },
      })

      // Who gets paid out on a death claim, so the addition is auditable. The
      // persisted row is logged (the id is server-assigned), minus the
      // idNumber and dateOfBirth — see beneficiaryAuditValue.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_BENEFICIARY_ADDED,
        entity: "InsuranceBeneficiary",
        entityId: beneficiary.id,
        newValue: beneficiaryAuditValue(beneficiary),
      })

      return NextResponse.json(beneficiary, { status: 201 })
    })
  } catch (error) {
    console.error("Failed to create beneficiary:", error)
    return NextResponse.json({ error: "Failed to create beneficiary" }, { status: 500 })
  }
}
