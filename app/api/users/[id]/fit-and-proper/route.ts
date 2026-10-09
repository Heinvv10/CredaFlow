import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const record = await prisma.fitAndProper.findFirst({
      where: { userId: id, user: { tenantId: tenant.id } },
    })

    // Return null body (not 404) so the UI can distinguish "not yet created" from errors
    return NextResponse.json(record)
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json() as {
      reExamType?: string
      reExamPassDate?: string
      licenceNumber?: string
      licenceExpiry?: string
      cpdHoursRequired?: number
      cpdHoursCompleted?: number
      cpdPeriodEnd?: string
      notes?: string
    }

    // Verify user exists within this tenant
    const user = await prisma.user.findFirst({ where: { id, tenantId: tenant.id }, select: { id: true } })
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const data = {
      reExamType: body.reExamType ?? null,
      reExamPassDate: body.reExamPassDate ? new Date(body.reExamPassDate) : null,
      licenceNumber: body.licenceNumber ?? null,
      licenceExpiry: body.licenceExpiry ? new Date(body.licenceExpiry) : null,
      cpdHoursRequired: body.cpdHoursRequired ?? 30,
      cpdHoursCompleted: body.cpdHoursCompleted ?? 0,
      cpdPeriodEnd: body.cpdPeriodEnd ? new Date(body.cpdPeriodEnd) : null,
      notes: body.notes ?? null,
    }

    const record = await prisma.fitAndProper.upsert({
      where: { userId: id },
      create: { userId: id, ...data },
      update: data,
    })

    return NextResponse.json(record)
  })
}
