import { createHash, randomUUID } from "node:crypto"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { deleteManagedFileStrict, saveFileToManagedPath } from "@/lib/storage"
import { RMCP_MAX_BYTES, isPdf, parseRmcpFields } from "@/lib/fic/rmcp"
import { ficTotpRefusal } from "@/lib/fic/session"

/**
 * GET  — the lender's RMCP versions, newest first.
 * POST — upload a new version (multipart: file = PDF, title, reviewDueAt
 *        YYYY-MM-DD). The next version number, the row and its audit entry
 *        commit together; a failed commit removes the stored file.
 * FIC compliance role. CredaFlow stores the lender's own document only.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("FIC Act compliance")
  if (notNca) return notNca
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const versions = await prisma.rmcpDocument.findMany({
      where: { tenantId: tenant.id },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, title: true, fileName: true, fileSize: true, sha256: true, uploadedById: true,
        uploadedAt: true, approvedById: true, approvedAt: true, approvalNote: true, reviewDueAt: true,
      },
    })
    return NextResponse.json({ versions })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("FIC Act compliance")
  if (notNca) return notNca
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const form = await req.formData().catch(() => null)
    const file = form?.get("file")
    const fields = parseRmcpFields(form?.get("title"), form?.get("reviewDueAt"))
    if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 })
    if (!(file instanceof File) || file.size === 0 || file.size > RMCP_MAX_BYTES) {
      return NextResponse.json({ error: "Attach the RMCP as a PDF of up to 10 MB." }, { status: 400 })
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    if (!isPdf(bytes)) return NextResponse.json({ error: "The RMCP must be a PDF." }, { status: 400 })

    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const { storagePath, fileSize } = await saveFileToManagedPath(bytes, "application/pdf", `rmcp_${randomUUID().replaceAll("-", "")}`)
    const fileName = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "rmcp.pdf"
    try {
      const created = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rmcp:${tenant.id}`}))`
        const latest = await tx.rmcpDocument.findFirst({ where: { tenantId: tenant.id }, orderBy: { version: "desc" }, select: { version: true } })
        const row = await tx.rmcpDocument.create({
          data: {
            tenantId: tenant.id,
            version: (latest?.version ?? 0) + 1,
            title: fields.value.title,
            fileName,
            mimeType: "application/pdf",
            storagePath,
            sha256,
            fileSize,
            uploadedById: guard.user.id,
            reviewDueAt: fields.value.reviewDueAt,
          },
          select: { id: true, version: true },
        })
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.RMCP_UPLOADED,
          entity: "RmcpDocument",
          entityId: row.id,
          newValue: { version: row.version, title: fields.value.title, sha256, fileSize, reviewDueAt: fields.value.reviewDueAt.toISOString().slice(0, 10) },
          ipAddress: callerIp(req),
        }, tx)
        return row
      })
      return NextResponse.json(created, { status: 201 })
    } catch (error) {
      await deleteManagedFileStrict(storagePath)
      throw error
    }
  })
}
