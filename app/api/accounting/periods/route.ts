import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AccountingPeriodError, closePeriod } from "@/lib/accounting/generate"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { UnbalancedJournalError } from "@/lib/accounting/verify"
import { AuditAction, logAudit } from "@/lib/audit"

// Accounting export history (GET, LOAN_ADMIN) and closing a month (POST,
// ADMIN; TOTP when the lender requires it). Closing is idempotent: a month
// already closed is returned unchanged.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const batches = await prisma.accountingExportBatch.findMany({
      where: { tenantId: tenant.id },
      orderBy: { periodStart: "desc" },
      take: 36,
      select: {
        id: true, periodKey: true, entryCount: true, lineCount: true, totalDebitCents: true, totalCreditCents: true, closedAt: true,
        xeroPush: { select: { status: true, xeroManualJournalId: true, error: true, updatedAt: true } },
      },
    })
    return NextResponse.json({
      batches: batches.map((b) => ({ ...b, totalDebitCents: Number(b.totalDebitCents), totalCreditCents: Number(b.totalCreditCents) })),
    })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "close an accounting period")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const period = (read.body as { period?: unknown } | null)?.period
    try {
      const out = await closePeriod(prisma, { tenantId: tenant.id, periodKey: String(period ?? ""), userId: guard.user.id, userEmail: guard.user.email })
      return NextResponse.json(out, { status: out.created ? 201 : 200 })
    } catch (error) {
      if (error instanceof AccountingPeriodError || error instanceof UnbalancedJournalError) {
        const code = error instanceof AccountingPeriodError ? error.code : "UNBALANCED"
        // A refused close is evidence too (a reconciliation failure, an unbalanced batch).
        await logAudit({
          tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
          action: AuditAction.ACCOUNTING_CLOSE_REFUSED, entity: "AccountingExportBatch", entityId: String(period ?? ""),
          newValue: { periodKey: String(period ?? ""), code, reason: error.message.slice(0, 500) },
        })
        return NextResponse.json({ error: error.message, code }, { status: code === "UNBALANCED" ? 500 : 422 })
      }
      throw error
    }
  })
}
