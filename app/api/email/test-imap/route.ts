import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { testImapLogin } from "@/lib/email/inbound-poll"
import { prisma } from "@/lib/prisma"

// Admin "Test IMAP" (Settings → Email). Sibling of /api/email/test, which sends
// an outbound message; this one only proves the mailbox login works, so an
// operator can diagnose dead inbound without emitting mail to anybody.
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    const result = await testImapLogin(tenant.id)

    // entityId matches the config route's audit rows (app/api/email/config/route.ts,
    // AuditAction.EMAIL_CONFIG_UPDATED): the EmailConfig row id, not the tenant
    // id, so the two audit trails for the same mailbox line up. Falls back to
    // the tenant id only if no EmailConfig row exists at all.
    const emailConfig = await prisma.emailConfig.findUnique({
      where: { tenantId: tenant.id },
      select: { id: true },
    })

    // Both outcomes are audited: a live NCA lender needs a record of who
    // touched the mail path and what it said. testImapLogin redacts the stored
    // credential out of the message before it gets here.
    await logAudit({
      tenantId: tenant.id,
      userId: actor?.id,
      userEmail: actor?.email ?? undefined,
      action: AuditAction.EMAIL_IMAP_TESTED,
      entity: "EmailConfig",
      entityId: emailConfig?.id ?? tenant.id,
      newValue: { ok: result.ok, message: result.message },
    })

    return NextResponse.json(result)
  })
}
