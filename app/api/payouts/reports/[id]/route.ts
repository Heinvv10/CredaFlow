import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { acknowledgeUnappliedReport } from "@/lib/payouts/unapplied-reports"

// Acknowledge a provider report not applied (lib/payouts/unapplied-reports.ts):
// { note } (at least 5 characters). LOAN_ADMIN; TOTP when the lender
// requires it; the caller's tenant only; audited; once.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "acknowledge a provider report")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const note = typeof (read.body as { note?: unknown } | null)?.note === "string" ? (read.body as { note: string }).note.trim().slice(0, 1000) : ""
    if (note.length < 5) return NextResponse.json({ error: "Say what you checked (at least 5 characters)" }, { status: 400 })
    const out = await acknowledgeUnappliedReport(prisma, { tenantId: tenant.id, id, note, actor: { id: guard.user.id, email: guard.user.email } })
    return out.ok ? NextResponse.json(out) : NextResponse.json({ error: out.error }, { status: out.status })
  })
}
