import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { readFile } from "@/lib/storage"

/**
 * GET   — download one RMCP version; the bytes must still match the stored hash.
 * PATCH — record its approval: { approvalNote }. Once; the trigger
 *         guardRmcpDocument refuses a second approval or any other change.
 * FIC compliance role.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
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
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { approvalNote?: unknown } | null
    const note = typeof body?.approvalNote === "string" ? body.approvalNote.trim().slice(0, 2000) : ""
    const outcome = await prisma.$transaction(async (tx) => {
      const approvedAt = new Date()
      const written = await tx.rmcpDocument.updateMany({
        where: { id, tenantId: tenant.id, approvedById: null },
        data: { approvedById: guard.user.id, approvedAt, approvalNote: note || null },
      })
      if (written.count !== 1) return false
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
      return true
    })
    if (!outcome) return NextResponse.json({ error: "Not found, or already approved." }, { status: 409 })
    return NextResponse.json({ ok: true })
  })
}
