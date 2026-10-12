import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseStaffUserWrite, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import bcrypt from "bcryptjs"
import type { UserRole } from "@prisma/client"
import { logAudit } from "@/lib/audit"

const ADMIN_ROLES: UserRole[] = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"]

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  if (!ADMIN_ROLES.includes(guard.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const [users, branches] = await Promise.all([
      prisma.user.findMany({
        where: { tenantId: tenant.id },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          active: true,
          phone: true,
          lastLoginAt: true,
          branchId: true,
          branch: { select: { id: true, name: true } },
          createdAt: true,
          updatedAt: true,
          _count: { select: { approvedLoans: true, assignedLoans: true, auditLogs: true } },
        },
      }),
      prisma.branch.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ])

    return NextResponse.json({ users, branches })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  if (!ADMIN_ROLES.includes(guard.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const body = await req.json()
    const { name, email, role, password, phone, branchId } = body as {
      name: string
      email: string
      role: UserRole
      password: string
      phone?: string
      branchId?: string
    }

    if (!name || !email || !role || !password) {
      return NextResponse.json({ error: "Name, email, role and password are required" }, { status: 400 })
    }
    // Body values reach Prisma as-is, where an object is a filter. The role is
    // checked by the write gate below.
    if (
      typeof name !== "string" || typeof email !== "string" || typeof password !== "string" ||
      (phone != null && typeof phone !== "string") || (branchId != null && typeof branchId !== "string")
    ) {
      return NextResponse.json({ error: "Invalid user details" }, { status: 400 })
    }

    // Before the email probe below, so its 409 tells a refused caller nothing.
    const refused = await refuseStaffUserWrite(guard.user, { tenantId: tenant.id, targetRole: null, assignedRole: role })
    if (refused) return refused

    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 })
    }

    // Branch must belong to the same tenant — otherwise a caller could
    // attach a Tenant B branch to a newly-created Tenant A user.
    if (branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: branchId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 })
    }

    const hashed = await bcrypt.hash(password, 12)

    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        name,
        email,
        role,
        password: hashed,
        phone: phone ?? null,
        branchId: branchId ?? null,
      },
      select: {
        id: true, name: true, email: true, role: true,
        active: true, phone: true, branchId: true,
        branch: { select: { id: true, name: true } },
        lastLoginAt: true, createdAt: true,
      },
    })

    await logAudit({
      tenantId: tenant.id,
      action: "USER_CREATED",
      entity: "User",
      entityId: user.id,
      userId: guard.user.id,
      newValue: { email: user.email, role: user.role, branchId: user.branchId },
    })

    return NextResponse.json(user, { status: 201 })
  })
}
