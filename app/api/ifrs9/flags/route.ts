import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { clearSicrFlag, setSicrFlag } from "@/lib/ifrs9/store"
import { SICR_FLAG_KINDS, type SicrFlagKind } from "@/lib/ifrs9/types"

// A significant-increase-in-credit-risk flag on one loan (a bureau downgrade, a behavioural signal, a watchlist
// entry): while active the loan is at least Stage 2 at the next run. The hook a bureau or scoring integration calls.
// GET ?loanId=: LOAN_ADMIN. POST { loanId, kind, reason } and DELETE ?id=: ADMIN, TOTP when required, audited.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const loanId = req.nextUrl.searchParams.get("loanId")
    if (!loanId) return NextResponse.json({ error: "loanId is required" }, { status: 400 })
    const flags = await prisma.ifrs9SicrFlag.findMany({ where: { tenantId: tenant.id, loanId }, orderBy: { setAt: "desc" } })
    return NextResponse.json({ flags: flags.map((f) => ({ id: f.id, kind: f.kind, reason: f.reason, setAt: f.setAt.toISOString(), clearedAt: f.clearedAt?.toISOString() ?? null })) })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "flag a loan for IFRS 9")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const { loanId, kind, reason } = (read.body ?? {}) as Record<string, unknown>
    if (typeof loanId !== "string" || !loanId) return NextResponse.json({ error: "loanId is required" }, { status: 400 })
    if (typeof kind !== "string" || !(SICR_FLAG_KINDS as readonly string[]).includes(kind)) return NextResponse.json({ error: `kind must be one of ${SICR_FLAG_KINDS.join(", ")}` }, { status: 400 })
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) return NextResponse.json({ error: "reason is required (at most 500 characters)" }, { status: 400 })
    if (!(await setSicrFlag(prisma, tenant.id, loanId, kind as SicrFlagKind, reason.trim(), guard.user))) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    return NextResponse.json({ ok: true }, { status: 201 })
  })
}

export async function DELETE(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "clear an IFRS 9 flag")
    if (refusal) return refusal
    const id = req.nextUrl.searchParams.get("id")
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
    if (!(await clearSicrFlag(prisma, tenant.id, id, guard.user))) return NextResponse.json({ error: "No active flag with that id" }, { status: 404 })
    return NextResponse.json({ ok: true })
  })
}
