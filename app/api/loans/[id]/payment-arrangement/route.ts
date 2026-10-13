import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { wouldRegressCollectionsStage } from "@/lib/collections/stages"

interface ArrangementBody {
  arrangementDate: string
  agreedAmount: number   // cents
  frequency: string      // WEEKLY | BIWEEKLY | MONTHLY
  startDate: string
  endDate: string
  notes?: string
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("COLLECTIONS_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const body: ArrangementBody = await req.json()

      if (!body.agreedAmount || !body.frequency || !body.startDate || !body.endDate) {
        return NextResponse.json({ error: "agreedAmount, frequency, startDate, endDate required" }, { status: 422 })
      }

      const mutation = await prisma.$transaction(async (tx) => {
        // A payment can cure or settle the account while the request is in
        // flight. Lock first, then perform the tenant and eligibility reads
        // from the same transaction that creates the legal arrangement.
        await lockLoanForUpdate(tx, id)
        const loan = await tx.loan.findFirst({
          where: { id, tenantId: tenant.id },
          select: {
            id: true,
            status: true,
            ncaRegime: true,
            arrearsAmount: true,
            outstandingPrincipal: true,
            daysInArrears: true,
            collectionsStage: true,
          },
        })
        if (!loan) return { kind: "NOT_FOUND" as const }

        const eligibility = evaluateCollectionsEligibility(loan, "DUNNING")
        if (!eligibility.eligible) {
          return { kind: "INELIGIBLE" as const, reason: eligibility.reason }
        }
        if (wouldRegressCollectionsStage(loan.collectionsStage, "PAYMENT_ARRANGEMENT")) {
          return { kind: "STAGE_CONFLICT" as const, currentStage: loan.collectionsStage }
        }

        const previousArrangement = await tx.paymentArrangement.findUnique({
          where: { loanId: id, tenantId: tenant.id },
          select: { id: true, agreedAmount: true, frequency: true, status: true },
        })

        // Upsert arrangement (replace if exists)
        const arr = await tx.paymentArrangement.upsert({
          where: { loanId: id, tenantId: tenant.id },
          update: {
            arrangementDate: new Date(body.arrangementDate ?? new Date()),
            agreedAmount: body.agreedAmount,
            frequency: body.frequency,
            startDate: new Date(body.startDate),
            endDate: new Date(body.endDate),
            notes: body.notes ?? null,
            status: "ACTIVE",
            createdById: guard.user.id,
          },
          create: {
            tenantId: tenant.id,
            loanId: id,
            arrangementDate: new Date(body.arrangementDate ?? new Date()),
            agreedAmount: body.agreedAmount,
            frequency: body.frequency,
            startDate: new Date(body.startDate),
            endDate: new Date(body.endDate),
            notes: body.notes ?? null,
            status: "ACTIVE",
            createdById: guard.user.id,
          },
        })

        // Advance stage
        await tx.loan.update({
          where: { id, tenantId: tenant.id },
          data: {
            collectionsStage: "PAYMENT_ARRANGEMENT",
            collectionsStageUpdatedAt: new Date(),
          },
        })

        // The arrangement and its legal/audit evidence are one atomic unit.
        // A failed audit insert rolls the transaction back instead of leaving
        // an unaudited collections state change behind.
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: previousArrangement
              ? "PAYMENT_ARRANGEMENT_UPDATED"
              : "PAYMENT_ARRANGEMENT_CREATED",
            entity: "Loan",
            entityId: id,
            oldValue: {
              stage: loan.collectionsStage,
              ...(previousArrangement ? { arrangement: previousArrangement } : {}),
            },
            newValue: {
              arrangementId: arr.id,
              stage: "PAYMENT_ARRANGEMENT",
              agreedAmount: body.agreedAmount,
              frequency: body.frequency,
            },
          },
        })

        return { kind: "CREATED" as const, arrangement: arr }
      })

      if (mutation.kind === "NOT_FOUND") {
        return NextResponse.json({ error: "Loan not found" }, { status: 404 })
      }
      if (mutation.kind === "INELIGIBLE") {
        return NextResponse.json(
          { error: `Cannot create a payment arrangement: ${mutation.reason}.` },
          { status: 422 },
        )
      }
      if (mutation.kind === "STAGE_CONFLICT") {
        return NextResponse.json(
          { error: `Cannot move collections stage from ${mutation.currentStage} to PAYMENT_ARRANGEMENT.` },
          { status: 409 },
        )
      }
      const arrangement = mutation.arrangement

      return NextResponse.json(arrangement)
    })
  } catch {
    return NextResponse.json({ error: "Failed to create payment arrangement" }, { status: 500 })
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const arrangement = await prisma.paymentArrangement.findFirst({ where: { loanId: id, tenantId: tenant.id } })
    return NextResponse.json(arrangement)
  })
}
