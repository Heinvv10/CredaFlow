import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const body = await req.json() as {
        pasqAcknowledged?: boolean
        recklessLendingAssessed?: boolean
        recklessLendingNote?: string
        clientAffordabilityDeclared?: boolean
      }
      if (body.pasqAcknowledged !== undefined) {
        return NextResponse.json({
          error: "Staff cannot record PASQ acknowledgement. The client must open and acknowledge the exact generated document in the portal.",
        }, { status: 403 })
      }

      const now = new Date()
      const saved = await prisma.$transaction(async (tx) => {
        const app = await tx.loanApplication.findUnique({
          where: { id, tenantId: tenant.id },
          select: { id: true },
        })
        if (!app) return false

        await tx.loanApplication.update({
          where: { id, tenantId: tenant.id },
          data: {
            ...(body.recklessLendingAssessed !== undefined && {
              recklessLendingAssessed: body.recklessLendingAssessed ?? false,
              recklessLendingAssessedById: body.recklessLendingAssessed ? guard.user.id : null,
              recklessLendingAssessedAt: body.recklessLendingAssessed ? now : null,
              recklessLendingNote: body.recklessLendingNote ?? null,
            }),
            ...(body.clientAffordabilityDeclared !== undefined && {
              clientAffordabilityDeclaredAt: body.clientAffordabilityDeclared ? now : null,
            }),
          },
        })

        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "COMPLIANCE_UPDATED",
            entity: "LoanApplication",
            entityId: id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            // The fields this route acts on, not the raw body: an audit row
            // records what changed, and never carries keys the body invents.
            newValue: {
              recklessLendingAssessed: body.recklessLendingAssessed,
              recklessLendingNote: body.recklessLendingNote,
              clientAffordabilityDeclared: body.clientAffordabilityDeclared,
            },
          },
        })
        return true
      })
      if (!saved) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }

      return NextResponse.json({ success: true })
    }) // end withTenantContext
  } catch {
    return NextResponse.json({ error: "Failed to save compliance" }, { status: 500 })
  }
}
