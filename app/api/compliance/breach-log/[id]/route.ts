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

  return withTenantContext(req, async () => {
    try {
      const { id } = await params
      const log = await prisma.breachLog.findUnique({ where: { id } })
      if (!log) return NextResponse.json({ error: "Breach log not found" }, { status: 404 })

      return NextResponse.json(log)
    } catch {
      return NextResponse.json({ error: "Failed to fetch breach log" }, { status: 500 })
    }
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async () => {
    try {
      const { id } = await params
      const existing = await prisma.breachLog.findUnique({ where: { id }, select: { id: true } })
      if (!existing) return NextResponse.json({ error: "Breach log not found" }, { status: 404 })

      const body = await req.json() as {
        status?: string
        containmentAction?: string
        reportedToIC?: boolean
        reportedAt?: string
      }

      const log = await prisma.breachLog.update({
        where: { id },
        data: {
          ...(body.status && { status: body.status }),
          ...(body.containmentAction !== undefined && { containmentAction: body.containmentAction }),
          ...(body.reportedToIC !== undefined && { reportedToIC: body.reportedToIC }),
          ...(body.reportedAt !== undefined && { reportedAt: body.reportedAt ? new Date(body.reportedAt) : null }),
        },
      })

      return NextResponse.json(log)
    } catch {
      return NextResponse.json({ error: "Failed to update breach log" }, { status: 500 })
    }
  })
}
