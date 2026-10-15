import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { readFile } from "@/lib/storage"
import { ficTotpRefusal } from "@/lib/fic/session"
import { getScreeningConfig } from "@/lib/screening/policy"

/**
 * GET   — download one RMCP version; the bytes must still match the stored
 *         hash, and the download is audited before the bytes are returned.
 * PATCH — record its approval: { approvalNote }. Once, and — while the lender
 *         requires a second reviewer — never by the user who uploaded it; the
 *         triggers guardRmcpDocument and RmcpDocument_second_reviewer repeat both.
 * FIC compliance role, TOTP-verified where the lender requires staff 2FA.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const { id } = await ctx.params
    const doc = await prisma.rmcpDocument.findFirst({
      where: { id, tenantId: tenant.id },
      select: { storagePath: true, sha256: true, fileName: true, version: true },
    })
    if (!doc) return NextResponse.json({ error: "RMCP version not found" }, { status: 404 })
    const bytes = await readFile(doc.storagePath)
    if (createHash("sha256").update(bytes).digest("hex") !== doc.sha256) {
      return NextResponse.json({ error: "The stored RMCP file failed its integrity check." }, { status: 409 })
    }
    await logAuditStrict({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.RMCP_DOWNLOADED,
      entity: "RmcpDocument",
      entityId: id,
      newValue: { version: doc.version, sha256: doc.sha256 },
      ipAddress: callerIp(req),
    })
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="rmcp-v${doc.version}.pdf"`,
        "Cache-Control": "no-store",
      },
    })
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { approvalNote?: unknown } | null
    const note = typeof body?.approvalNote === "string" ? body.approvalNote.trim().slice(0, 2000) : ""
    const outcome = await prisma.$transaction(async (tx) => {
      const doc = await tx.rmcpDocument.findFirst({ where: { id, tenantId: tenant.id }, select: { uploadedById: true, approvedById: true } })
      if (!doc) return { status: 404 as const, error: "RMCP version not found." }
      if (doc.approvedById) return { status: 409 as const, error: "This version is already approved." }
      const { requireSecondReviewer } = await getScreeningConfig(tenant.id, tx)
      if (requireSecondReviewer && doc.uploadedById === guard.user.id) {
        return { status: 403 as const, error: "You uploaded this version; another compliance officer must approve it." }
      }
      const approvedAt = new Date()
      const written = await tx.rmcpDocument.updateMany({
        where: { id, tenantId: tenant.id, approvedById: null },
        data: { approvedById: guard.user.id, approvedAt, approvalNote: note || null },
      })
      if (written.count !== 1) return { status: 409 as const, error: "This version is already approved." }
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.RMCP_APPROVED,
        entity: "RmcpDocument",
        entityId: id,
        oldValue: { approvedById: null },
        newValue: { approvedById: guard.user.id, approvedAt: approvedAt.toISOString(), approvalNote: note || null },
        ipAddress: callerIp(req),
      }, tx)
      return { status: 200 as const }
    })
    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ ok: true })
  })
}
