import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseStaffUserWrite, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import bcrypt from "bcryptjs"
import { Prisma, type UserRole } from "@prisma/client"
import { logAudit } from "@/lib/audit"

const ADMIN_ROLES: UserRole[] = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"]

interface RouteParams { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  if (!ADMIN_ROLES.includes(guard.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json()
    const { name, email, role, active, password, phone, branchId } = body as {
      name?: string; email?: string; role?: UserRole; active?: boolean
      password?: string; phone?: string; branchId?: string | null
    }

    if (id === guard.user.id && active === false) {
      return NextResponse.json({ error: "You cannot deactivate your own account" }, { status: 400 })
    }
    if (id === guard.user.id && role && role !== guard.user.role) {
      return NextResponse.json({ error: "You cannot change your own role" }, { status: 400 })
    }

    // Scope by tenant so a caller can't mutate another tenant's users by
    // guessing or knowing an id (User.email is globally unique but ids leak
    // through audit logs and URLs).
    const existing = await prisma.user.findFirst({
      where: { id, tenantId: tenant.id },
      select: { role: true, active: true, name: true, email: true },
    })
    if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 })

    // The role ceiling: nobody edits a user who outranks them, or assigns a
    // role above their own. Checked BEFORE the email-uniqueness probe so an
    // unauthorised caller can't use the 409 to learn whether an email is
    // already registered.
    const refused = await refuseStaffUserWrite(guard.user, {
      tenantId: tenant.id, targetId: id, targetRole: existing.role, assignedRole: role,
    })
    if (refused) return refused

    // Email change is an identity change: normalise, validate shape, and
    // guard the global @unique constraint with a friendly 409 before hitting
    // the DB. Only treated as a change when it differs from the current value.
    let normalizedEmail: string | undefined
    if (email !== undefined) {
      normalizedEmail = email.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 })
      }
      // Case-insensitive compare so re-saving an unchanged email (incl. legacy
      // mixed-case rows) is a true no-op — never a phantom sign-out when the
      // admin only edited another field. Login lowercases before lookup
      // (lib/auth.ts), so lowercase storage is the correct, consistent form.
      if (normalizedEmail !== existing.email.toLowerCase()) {
        const clash = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          select: { id: true },
        })
        if (clash && clash.id !== id) {
          return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 })
        }
      } else {
        normalizedEmail = undefined // unchanged — don't touch it or bump tokenVersion
      }
    }

    // If branchId is being set (non-null), verify the branch belongs to the
    // same tenant — same threat as POST.
    if (branchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: branchId, tenantId: tenant.id },
        select: { id: true },
      })
      if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 })
    }

    const data: Record<string, unknown> = {}
    if (name !== undefined) data.name = name
    if (normalizedEmail !== undefined) data.email = normalizedEmail
    if (role !== undefined) data.role = role
    if (active !== undefined) data.active = active
    if (phone !== undefined) data.phone = phone
    if (branchId !== undefined) data.branchId = branchId

    if (password) {
      if (password.length < 8) {
        return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })
      }
      data.password = await bcrypt.hash(password, 12)
    }

    // Any change to email / role / active / password invalidates existing
    // sessions. Bumping tokenVersion forces the next JWT decode (see
    // lib/auth.ts) to fail and sign the user out — for email this makes them
    // re-login with the new address.
    const securitySensitiveChange =
      normalizedEmail !== undefined || role !== undefined ||
      active !== undefined || password !== undefined
    if (securitySensitiveChange) {
      data.tokenVersion = { increment: 1 }
    }

    let user
    try {
      user = await prisma.user.update({
        where: { id },
        data,
        select: {
          id: true, name: true, email: true, role: true,
          active: true, phone: true, branchId: true,
          branch: { select: { id: true, name: true } },
          lastLoginAt: true, createdAt: true,
        },
      })
    } catch (err) {
      // The findUnique pre-check above is racy: a concurrent rename to the same
      // email can slip past it and only collide at the DB unique index (P2002).
      // Surface the same friendly 409 rather than a raw 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 })
      }
      throw err
    }

    const roleChanged = role !== undefined && role !== existing.role
    await logAudit({
      tenantId: tenant.id,
      action: "USER_UPDATED",
      entity: "User",
      entityId: id,
      userId: guard.user.id,
      // Capture the email and role transitions explicitly — identity and
      // privilege changes auditors will want to trace, not just a changed-key
      // name.
      oldValue: normalizedEmail !== undefined || roleChanged
        ? {
            ...(normalizedEmail !== undefined ? { email: existing.email } : {}),
            ...(roleChanged ? { role: existing.role } : {}),
          }
        : undefined,
      newValue: {
        changed: Object.keys(data).filter(k => k !== "password" && k !== "tokenVersion"),
        ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
        ...(roleChanged ? { role: user.role } : {}),
      },
    })

    return NextResponse.json(user)
  })
}

// Smart delete: physically remove a staff account that has NO operator-identity
// trail, otherwise fall back to deactivation. Restricted to SUPER_ADMIN because
// a hard delete is irreversible. Everyone at LOAN_ADMIN+ still deactivates via
// PATCH { active: false }.
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const guard = await requireApiRole("BRANCH_MANAGER")
  if (guard.error) return guard.error
  if (guard.user.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Only Super Admins can delete users" }, { status: 403 })
  }
  // Capture while `guard` is narrowed — TS widens it back inside the nested
  // deactivate() closure below.
  const actorId = guard.user.id

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    if (id === guard.user.id) {
      return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 })
    }

    // Tenant ownership check. Same rationale as PATCH: ids aren't secret, so
    // the where clause has to be scoped. Pull the identity-relation counts in
    // the same round-trip to decide hard-delete vs deactivate.
    const target = await prisma.user.findFirst({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        role: true,
        // FAIS Fit & Proper (RE exam, licence, CPD hours) is itself a
        // regulatory record — its mere presence is operator-identity history,
        // so a user who has one is deactivated, never hard-deleted (which would
        // destroy the record). 1:1 relation, so selected directly not _count'd.
        fitAndProper: { select: { id: true } },
        _count: {
          select: {
            // Operator-identity / record-of-advice trail. Most of these are
            // optional FKs that would SILENTLY SetNull on delete (erasing the
            // trail), so the DB won't stop us — this app-level check is the
            // real POPIA s.17 / FAIS s.3(2) guard.
            approvedLoans: true,
            assignedLoans: true,
            bureauOverriddenApplications: true,
            auditLogs: true,
            advisorPolicies: true,
            advisorCommissions: true,
            assessedClaims: true,
            coiDeclarations: true,
            messagesAuthored: true,
            messagesDisclosureDelivered: true,
            contactConsentsCaptured: true,
            contactMergesPerformed: true,
          },
        },
      },
    })
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 })

    const refused = await refuseStaffUserWrite(guard.user, {
      tenantId: tenant.id, targetId: id, targetRole: target.role, assignedRole: undefined,
    })
    if (refused) return refused

    const hasHistory =
      target.fitAndProper !== null ||
      Object.values(target._count).some((n) => n > 0)

    async function deactivate() {
      await prisma.user.update({
        where: { id },
        data: { active: false, tokenVersion: { increment: 1 } },
        select: { id: true },
      })
      await logAudit({
        tenantId: tenant.id,
        action: "USER_DEACTIVATED",
        entity: "User",
        entityId: id,
        userId: actorId,
      })
    }

    if (hasHistory) {
      await deactivate()
      return NextResponse.json({
        mode: "deactivated",
        message: "User has loan, audit or advisory history — deactivated instead of deleted.",
      })
    }

    // No trail: physically remove the row. sessions, accounts, loginLogs and
    // manualProgress cascade; agentTasks and assignedConversations SetNull. The
    // USER_DELETED audit row is written IN THE SAME TRANSACTION so an
    // irreversible delete can never commit untraced — logAudit swallows its own
    // errors, which is acceptable for reversible actions but not a hard delete.
    try {
      await prisma.$transaction([
        prisma.user.delete({ where: { id } }),
        prisma.auditLog.create({
          data: {
            tenantId: tenant.id,
            userId: actorId,
            action: "USER_DELETED",
            entity: "User",
            entityId: id,
          },
        }),
      ])
    } catch (err) {
      // Belt-and-braces: any un-enumerated Restrict relation would throw a
      // foreign-key error (P2003). Never 500 — fall back to deactivation.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        await deactivate()
        return NextResponse.json({
          mode: "deactivated",
          message: "User has linked records — deactivated instead of deleted.",
        })
      }
      throw err
    }

    return NextResponse.json({ mode: "deleted", message: "User permanently deleted." })
  })
}
