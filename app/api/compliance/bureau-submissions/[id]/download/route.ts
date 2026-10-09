import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { renderSubmission, sha256Of } from "@/lib/bureau-submission/render"
import { isBureauSubmissionEnabled } from "@/lib/bureau-submission/staff-view.server"

/**
 * Download a bureau file. The bytes are re-rendered from the ledger snapshot,
 * never from live loan columns, and are refused if they no longer hash to
 * what was stored at generation.
 *
 * Every line carries an ID number and a full name, so a generic READONLY
 * export permission is too broad: LOAN_ADMIN, the same gate as the
 * ncr-quarterly export. Fail closed — no bytes leave unless the access is
 * durably audited first.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    if (!(await isBureauSubmissionEnabled(tenant.id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const rendered = await renderSubmission(prisma, tenant.id, id)
    if (!rendered) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (rendered.superseded) {
      return NextResponse.json(
        { error: "This test file was replaced by a newer one and its lines are no longer kept. Download the newest file." },
        { status: 410 },
      )
    }
    if (!rendered.intact) {
      return NextResponse.json(
        { error: "The ledger no longer reproduces the file that was generated. It was not downloaded." },
        { status: 409 },
      )
    }
    const sha256 = sha256Of(rendered.content)

    await logAuditStrict({
      tenantId: tenant.id,
      userId: user.id,
      userEmail: user.email,
      action: AuditAction.BUREAU_SUBMISSION_DOWNLOADED,
      entity: "BureauSubmission",
      entityId: rendered.id,
      newValue: { fileName: rendered.fileName, sha256, recordCount: rendered.recordCount },
    })

    return new NextResponse(Buffer.from(rendered.content, "latin1"), {
      headers: {
        "Content-Type": "text/plain; charset=us-ascii",
        "Content-Disposition": `attachment; filename="${rendered.fileName}.txt"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Content-Sha256": sha256,
      },
    })
  })
}
