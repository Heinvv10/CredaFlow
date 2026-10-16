import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { formatCents, toCents } from "@/lib/insurance/rand-cents"
import { DECIMAL_12_2_MAX_CENTS, parseDecimalAmount } from "../../decimal-input"

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

      const claim = await prisma.insuranceClaim.findFirst({
        where: { id, tenantId: tenant.id },
        include: {
          policy: {
            select: {
              policyNumber: true,
              type: true,
              client: { select: { firstName: true, lastName: true, idNumber: true } },
            },
          },
          assessor: { select: { id: true, name: true, email: true } },
        },
      })

      if (!claim) return NextResponse.json({ error: "Claim not found" }, { status: 404 })
      return NextResponse.json(claim)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch claim" }, { status: 500 })
  }
}

export async function PATCH(
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
        action?: "approve" | "reject"
        assessorId?: string
        insurerRef?: string
        approvedAmount?: number
        rejectionReason?: string
        // Generic status update
        status?: string
        notes?: string
        // Enriched claim fields
        claimType?: string
        incidentDate?: string
        fnolDate?: string
      }

      if (body.action === "approve") {
        if (body.approvedAmount == null) {
          return NextResponse.json({ error: "approvedAmount is required for approval" }, { status: 400 })
        }
        const parsed = parseDecimalAmount("approvedAmount", body.approvedAmount, { maxCents: DECIMAL_12_2_MAX_CENTS })
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
        const approvedAmount = parsed.value

        // The insurer pays at most what was claimed, and never more than the
        // cover. Compared in exact cents (Decimal columns, never a float).
        const current = await prisma.insuranceClaim.findFirst({
          where: { id, tenantId: tenant.id },
          select: { claimAmount: true, policy: { select: { sumAssured: true } } },
        })
        if (!current) return NextResponse.json({ error: "Claim not found" }, { status: 404 })
        const approvedCents = toCents(approvedAmount)
        if (approvedCents > toCents(current.claimAmount)) {
          return NextResponse.json(
            { error: `The approved amount cannot exceed the amount claimed (${formatCents(toCents(current.claimAmount))}).` },
            { status: 422 },
          )
        }
        if (approvedCents > toCents(current.policy.sumAssured)) {
          return NextResponse.json(
            { error: `The approved amount cannot exceed the policy's sum assured (${formatCents(toCents(current.policy.sumAssured))}).` },
            { status: 422 },
          )
        }

        // Both bounds again in the write itself, so a claim or policy changed
        // since the read cannot slip an amount past them.
        const written = await prisma.insuranceClaim.updateMany({
          where: {
            id,
            tenantId: tenant.id,
            claimAmount: { gte: approvedAmount },
            policy: { sumAssured: { gte: approvedAmount } },
          },
          data: {
            status: "APPROVED",
            approvedAmount,
            resolvedAt: new Date(),
            ...(body.assessorId !== undefined ? { assessorId: body.assessorId } : {}),
            ...(body.insurerRef !== undefined ? { insurerRef: body.insurerRef } : {}),
          },
        })
        if (written.count === 0) {
          return NextResponse.json({ error: "The claim changed while it was being approved. Refresh and try again." }, { status: 409 })
        }
        const claim = await prisma.insuranceClaim.findFirst({ where: { id, tenantId: tenant.id } })

        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_CLAIM_APPROVED,
          entity: "InsuranceClaim",
          entityId: id,
          newValue: {
            status: "APPROVED",
            approvedAmount,
            ...(body.assessorId !== undefined ? { assessorId: body.assessorId } : {}),
            ...(body.insurerRef !== undefined ? { insurerRef: body.insurerRef } : {}),
          },
        })

        return NextResponse.json(claim)
      }

      if (body.action === "reject") {
        if (!body.rejectionReason) {
          return NextResponse.json({ error: "rejectionReason is required for rejection" }, { status: 400 })
        }

        const claim = await prisma.insuranceClaim.update({
          where: { id, tenantId: tenant.id },
          data: {
            status: "REJECTED",
            resolvedAt: new Date(),
            rejectionReason: body.rejectionReason,
            ...(body.assessorId !== undefined ? { assessorId: body.assessorId } : {}),
            ...(body.insurerRef !== undefined ? { insurerRef: body.insurerRef } : {}),
          },
        })

        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_CLAIM_REJECTED,
          entity: "InsuranceClaim",
          entityId: id,
          newValue: {
            status: "REJECTED",
            rejectionReason: body.rejectionReason,
            ...(body.assessorId !== undefined ? { assessorId: body.assessorId } : {}),
            ...(body.insurerRef !== undefined ? { insurerRef: body.insurerRef } : {}),
          },
        })

        return NextResponse.json(claim)
      }

      // Generic update (status / notes / enriched fields)
      const updateData: Record<string, unknown> = {}
      if (body.status) updateData.status = body.status
      if (body.notes !== undefined) updateData.notes = body.notes
      if (body.claimType !== undefined) updateData.claimType = body.claimType
      if (body.incidentDate !== undefined) updateData.incidentDate = body.incidentDate ? new Date(body.incidentDate) : null
      if (body.fnolDate !== undefined) updateData.fnolDate = body.fnolDate ? new Date(body.fnolDate) : null
      if (body.assessorId !== undefined) updateData.assessorId = body.assessorId
      if (body.insurerRef !== undefined) updateData.insurerRef = body.insurerRef
      if (body.rejectionReason !== undefined) updateData.rejectionReason = body.rejectionReason

      const claim = await prisma.insuranceClaim.update({ where: { id, tenantId: tenant.id }, data: updateData })

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_CLAIM_UPDATED,
        entity: "InsuranceClaim",
        entityId: id,
        newValue: updateData,
      })

      return NextResponse.json(claim)
    })
  } catch (error) {
    console.error("Failed to update claim:", error)
    return NextResponse.json({ error: "Failed to update claim" }, { status: 500 })
  }
}
