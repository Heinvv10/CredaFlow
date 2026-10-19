import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { splitPaymentPlan } from "@/lib/collections/payment-plan"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const loan = await prisma.loan.findFirst({
      where: { id, tenantId: tenant.id },
      select: { id: true },
    })
    if (!loan) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const plan = await prisma.paymentPlan.findUnique({ where: { loanId: id } })
    return NextResponse.json(plan)
  })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()

    // Work in integer cents. The client's float instalment is ignored: the
    // regular instalment is floor(total / n) and the last one (derived, not
    // stored) absorbs the remainder, so the plan sums exactly to the arrears.
    const totalCents = Math.round(Number(body.totalArrears) * 100)
    const installments = Number(body.installments)
    if (!Number.isInteger(totalCents) || totalCents <= 0 || !Number.isInteger(installments) || installments < 1) {
      return NextResponse.json({ error: "totalArrears must be positive and installments a whole number >= 1" }, { status: 400 })
    }
    const { regularCents, finalCents } = splitPaymentPlan(totalCents, installments)
    const rands = (cents: number) => (cents / 100).toFixed(2)
    const amountText = finalCents === regularCents
      ? `${installments} × R${rands(regularCents)}/month`
      : `${installments - 1} × R${rands(regularCents)} + final instalment R${rands(finalCents)} (R${rands(totalCents)} total), monthly`

    // Snapshot the prior plan so the audit records what an upsert overwrote.
    const previousPlan = await prisma.paymentPlan.findUnique({ where: { loanId: id } })

    const plan = await prisma.paymentPlan.upsert({
      where: { loanId: id },
      update: {
        totalArrears: totalCents,
        installments,
        installmentAmt: regularCents,
        startDate: new Date(body.startDate),
        notes: body.notes ?? null,
        active: true,
        createdBy: guard.user.email ?? "system",
      },
      create: {
        loanId: id,
        totalArrears: totalCents,
        installments,
        installmentAmt: regularCents,
        startDate: new Date(body.startDate),
        notes: body.notes ?? null,
        active: true,
        createdBy: guard.user.email ?? "system",
      },
    })

    // Log it as a note too
    await prisma.loanNote.create({
      data: {
        tenantId: tenant.id,
        loanId: id,
        type: "payment_plan",
        note: `Payment plan created: ${amountText} starting ${body.startDate}${body.notes ? ` — ${body.notes}` : ""}`,
        createdBy: guard.user.email ?? "system",
      },
    })

    // Audit trail: a payment plan is a collections commitment — record it.
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email ?? undefined,
      action: "PAYMENT_PLAN_UPSERTED",
      entity: "Loan",
      entityId: id,
      oldValue: previousPlan
        ? {
            totalArrears: previousPlan.totalArrears,
            installments: previousPlan.installments,
            installmentAmt: previousPlan.installmentAmt,
            startDate: previousPlan.startDate,
          }
        : null,
      newValue: {
        totalArrears: plan.totalArrears,
        installments: plan.installments,
        installmentAmt: plan.installmentAmt,
        startDate: plan.startDate,
      },
    })

    return NextResponse.json(plan, { status: 201 })
  })
}
