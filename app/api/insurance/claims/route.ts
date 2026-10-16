import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, ClaimStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { generateReference } from "@/lib/utils"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { DECIMAL_12_2_MAX_CENTS, parseDecimalAmount } from "../decimal-input"

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { searchParams } = new URL(req.url)
      const status = searchParams.get("status")

      if (status && !Object.values(ClaimStatus).includes(status as ClaimStatus)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 })
      }

      const where: Prisma.InsuranceClaimWhereInput = { tenantId: tenant.id }
      if (status) where.status = status as ClaimStatus

      const claims = await prisma.insuranceClaim.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        include: {
          policy: { select: { policyNumber: true, type: true, clientId: true, client: { select: { firstName: true, lastName: true, phone: true } } } },
          assessor: { select: { id: true, name: true, email: true } },
        },
      })

      return NextResponse.json(claims)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch claims" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const data = await req.json()

      if (!data.policyId) {
        return NextResponse.json({ error: "policyId is required" }, { status: 400 })
      }
      // A numeric string is accepted as well as a number (form fields arrive as text).
      const amountInput = typeof data.claimAmount === "string" && data.claimAmount.trim() !== "" ? Number(data.claimAmount) : data.claimAmount
      const claimAmount = parseDecimalAmount("claimAmount", amountInput, { maxCents: DECIMAL_12_2_MAX_CENTS })
      if (!claimAmount.ok) {
        return NextResponse.json({ error: claimAmount.error }, { status: 400 })
      }
      const policy = await prisma.insurancePolicy.findFirst({
        where: { id: data.policyId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!policy) {
        return NextResponse.json({ error: "Policy not found" }, { status: 404 })
      }

      const claim = await prisma.insuranceClaim.create({
        data: {
          tenantId: tenant.id,
          policyId: data.policyId,
          claimNumber: generateReference("CLM"),
          status: "SUBMITTED",
          claimAmount: claimAmount.value,
          notes: data.notes || null,
          submittedAt: new Date(),
          claimType: data.claimType || null,
          incidentDate: data.incidentDate ? new Date(data.incidentDate) : null,
          fnolDate: data.fnolDate ? new Date(data.fnolDate) : null,
        },
      })

      // The claim's outcomes are audited in claims/[id]; this is the event that
      // opens it. claimNumber and status are server-assigned, so the persisted
      // row is logged rather than the request body.
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_CLAIM_SUBMITTED,
        entity: "InsuranceClaim",
        entityId: claim.id,
        newValue: claim,
      })

      return NextResponse.json(claim, { status: 201 })
    })
  } catch {
    return NextResponse.json({ error: "Failed to create claim" }, { status: 500 })
  }
}
