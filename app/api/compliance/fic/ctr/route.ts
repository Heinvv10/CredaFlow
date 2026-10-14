import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { isReportableCash } from "@/lib/fic/cash-threshold"
import { loadCtrRegister } from "@/lib/fic/registers"
import { ficTotpRefusal } from "@/lib/fic/session"

/**
 * GET  — the cash threshold register (derived from CASH receipts).
 * POST — record what was done with one receipt: { paymentId, status: "FILED",
 *        fiuReference, filedAt } or { paymentId, status: "NOT_REPORTABLE", note }.
 *        Once per receipt; append-only in the database. FIC compliance role.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    return NextResponse.json(await loadCtrRegister(tenant.id))
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const totp = await ficTotpRefusal(guard.user, tenant.id)
    if (totp) return totp
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId : ""
    const status = body?.status
    const fiuReference = typeof body?.fiuReference === "string" ? body.fiuReference.trim() : ""
    const note = typeof body?.note === "string" ? body.note.trim() : ""
    const filedAt = typeof body?.filedAt === "string" ? new Date(body.filedAt) : null
    if (status === "FILED" && (!fiuReference || !filedAt || Number.isNaN(filedAt.getTime()) || filedAt.getTime() > Date.now())) {
      return NextResponse.json({ error: "A filed report needs its FIC reference and a filing date not in the future." }, { status: 400 })
    }
    if (status === "NOT_REPORTABLE" && [...note].length < 15) {
      return NextResponse.json({ error: "Say why the receipt is not reportable (at least 15 characters)." }, { status: 400 })
    }
    if (!paymentId || (status !== "FILED" && status !== "NOT_REPORTABLE")) {
      return NextResponse.json({ error: "Send paymentId and status FILED or NOT_REPORTABLE." }, { status: 400 })
    }

    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, tenantId: tenant.id },
      select: { id: true, amount: true, paymentMethod: true, reversed: true, cashThresholdReport: { select: { id: true } } },
    })
    if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 })
    if (!isReportableCash(payment)) {
      return NextResponse.json({ error: "This receipt is not a cash receipt at or above the threshold." }, { status: 422 })
    }
    if (payment.cashThresholdReport) {
      return NextResponse.json({ error: "An outcome is already recorded for this receipt." }, { status: 409 })
    }

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.cashThresholdReport.create({
        data: {
          tenantId: tenant.id,
          paymentId,
          amountCents: payment.amount,
          status,
          fiuReference: status === "FILED" ? fiuReference : null,
          filedAt: status === "FILED" ? filedAt : null,
          note: note || null,
          recordedById: guard.user.id,
        },
        select: { id: true },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.CTR_RECORDED,
        entity: "CashThresholdReport",
        entityId: row.id,
        newValue: { paymentId, status, amountCents: payment.amount, fiuReference: status === "FILED" ? fiuReference : null },
        ipAddress: callerIp(req),
      }, tx)
      return row
    })
    return NextResponse.json({ ok: true, id: created.id }, { status: 201 })
  })
}
