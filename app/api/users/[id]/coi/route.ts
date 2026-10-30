import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { auth } from "@/lib/auth"
import { sastParts } from "@/lib/date/sast"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const declarations = await prisma.coiDeclaration.findMany({
      where: { userId: id, user: { tenantId: tenant.id } },
      orderBy: { year: "desc" },
    })

    return NextResponse.json(declarations)
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // FSCA Code of Conduct s3.1: each representative must attest personally.
  // Allow self-POST (any staff role declaring for themselves) OR ADMIN/SUPER_ADMIN
  // acting on behalf. Tenant isolation is enforced below by findFirst on the
  // target user.
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (session.user.role === "CLIENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id } = await params
  const isSelf = session.user.id === id
  const isAdmin = session.user.role === "ADMIN" || session.user.role === "SUPER_ADMIN"
  if (!isSelf && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      year?: number
      hasConflict?: boolean
      details?: string
    }

    if (body.details && body.details.length > 2000) {
      return NextResponse.json(
        { error: "details must be 2000 characters or fewer" },
        { status: 400 },
      )
    }

    // SAST year — see the COI page. A declaration made just after midnight on
    // 1 January must land in the new year, not the one that just ended.
  const year = body.year ?? sastParts(new Date()).year

    const user = await prisma.user.findFirst({ where: { id, tenantId: tenant.id, isSystem: false }, select: { id: true } })
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const declaration = await prisma.coiDeclaration.upsert({
      where: { userId_year: { userId: id, year } },
      create: {
        tenantId: tenant.id,
        userId: id,
        year,
        hasConflict: body.hasConflict ?? false,
        details: body.details ?? null,
      },
      update: {
        hasConflict: body.hasConflict ?? false,
        details: body.details ?? null,
        declaredAt: new Date(),
      },
    })

    await logAudit({
      tenantId: tenant.id,
      action: "COI_DECLARATION_UPSERTED",
      entity: "CoiDeclaration",
      entityId: declaration.id,
      userId: session.user.id,
      newValue: { year, hasConflict: body.hasConflict },
    })

    return NextResponse.json(declaration)
  })
}
