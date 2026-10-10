import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"

// The switch for the bank-statement CSV import (lib/bank-sync/import.ts, the
// one money-import path). It moves only `TenantConfig.bankSyncEnabled`;
// importStatement reads the row uncached, so it takes effect immediately.
// ADMIN + a TOTP-verified session, like the other tenant config writes that
// change how money enters the books (see app/api/settings/identity/route.ts).

// Schema default (prisma/schema.prisma model TenantConfig).
const DEFAULT_BANK_SYNC_ENABLED = false

const SELECT = { bankSyncEnabled: true } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: SELECT,
      })
      return NextResponse.json({ bankSyncEnabled: config?.bankSyncEnabled ?? DEFAULT_BANK_SYNC_ENABLED })
    } catch (e) {
      console.error("Failed to load bank sync flag:", e)
      return NextResponse.json({ error: "Failed to load the bank sync setting" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  // Writes require that THIS session's sign-in verified a TOTP code.
  if (guard.user.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change bank statement import. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const enabled = (body as { bankSyncEnabled?: unknown } | null)?.bankSyncEnabled
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "bankSyncEnabled must be true or false." }, { status: 400 })
    }

    try {
      // Read-then-write in one transaction so the audited "old" value is exactly
      // the state this write replaced.
      await prisma.$transaction(async (tx) => {
        const prev = await tx.tenantConfig.findUnique({
          where: { tenantId: tenant.id },
          select: SELECT,
        })
        await tx.tenantConfig.upsert({
          where: { tenantId: tenant.id },
          update: { bankSyncEnabled: enabled },
          create: { tenantId: tenant.id, bankSyncEnabled: enabled },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: enabled ? AuditAction.BANK_SYNC_ENABLED : AuditAction.BANK_SYNC_DISABLED,
            entity: "TenantConfig",
            entityId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            oldValue: prev ?? { bankSyncEnabled: DEFAULT_BANK_SYNC_ENABLED },
            newValue: { bankSyncEnabled: enabled },
            ipAddress: callerIp(req),
          },
        })
      })

      return NextResponse.json({ ok: true, bankSyncEnabled: enabled })
    } catch (e) {
      console.error("Failed to update bank sync flag:", e)
      return NextResponse.json({ error: "Failed to update the bank sync setting" }, { status: 500 })
    }
  })
}
