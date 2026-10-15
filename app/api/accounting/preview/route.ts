import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { ACCOUNT_ROLES, DEFAULT_ACCOUNTS } from "@/lib/accounting/accounts"
import { parsePeriodKey } from "@/lib/accounting/period"
import { planPeriod } from "@/lib/accounting/plan"
import type { ControlMismatch } from "@/lib/accounting/reconcile-controls"

// What a month's journals would be (or are, once closed): totals per account
// and per event type, whether it may close, the loan-book tie-out and the
// asset-finance controls that differ.
// Read-only; LOAN_ADMIN.

type Line = { role: string; accountCode: string; debitCents: number; creditCents: number }

function summarise(lines: Line[], eventTypes: string[]) {
  const accounts = new Map<string, Line>()
  for (const l of lines) {
    const key = `${l.role}|${l.accountCode}`
    const row = accounts.get(key) ?? { role: l.role, accountCode: l.accountCode, debitCents: 0, creditCents: 0 }
    row.debitCents += l.debitCents
    row.creditCents += l.creditCents
    accounts.set(key, row)
  }
  const events = new Map<string, number>()
  for (const t of eventTypes) events.set(t, (events.get(t) ?? 0) + 1)
  const order = (role: string) => (ACCOUNT_ROLES as readonly string[]).indexOf(role)
  return {
    accounts: [...accounts.values()]
      .sort((a, b) => order(a.role) - order(b.role) || a.accountCode.localeCompare(b.accountCode))
      .map((a) => ({ ...a, name: DEFAULT_ACCOUNTS[a.role as keyof typeof DEFAULT_ACCOUNTS]?.name ?? a.role })),
    events: Object.fromEntries([...events.entries()].sort()),
    debitCents: lines.reduce((s, l) => s + l.debitCents, 0),
    creditCents: lines.reduce((s, l) => s + l.creditCents, 0),
  }
}

/** A control's key is a contract id or a recovery id: name the contract by its reference. */
async function controlsWithReferences(tenantId: string, controls: ControlMismatch[]) {
  // Cap first: only what is shown is resolved.
  const shown = controls.slice(0, 50)
  const keys = [...new Set(shown.map((c) => c.key))]
  if (keys.length === 0) return []
  const [loans, recoveries] = await Promise.all([
    prisma.loan.findMany({ where: { tenantId, id: { in: keys } }, select: { id: true, reference: true } }),
    prisma.recovery.findMany({ where: { tenantId, id: { in: keys } }, select: { id: true, loan: { select: { reference: true } } } }),
  ])
  const names = new Map<string, string>([...loans.map((l) => [l.id, l.reference] as const), ...recoveries.map((r) => [r.id, `${r.loan.reference} (recovery)`] as const)])
  return shown.map((c) => ({ ...c, reference: names.get(c.key) ?? null }))
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const period = parsePeriodKey(req.nextUrl.searchParams.get("period"))
    if (!period) return NextResponse.json({ error: "period must be yyyy-mm" }, { status: 400 })
    const closed = await prisma.accountingExportBatch.findFirst({ where: { tenantId: tenant.id, periodKey: period.key }, select: { id: true } })
    if (closed) {
      const entries = await prisma.accountingLedgerEntry.findMany({
        where: { tenantId: tenant.id, batchId: closed.id },
        select: { eventType: true, lines: { select: { role: true, accountCode: true, debitCents: true, creditCents: true } } },
      })
      return NextResponse.json({
        period: period.key, label: period.label, closed: true, batchId: closed.id, entryCount: entries.length,
        refusal: null, reconciliation: null,
        ...summarise(entries.flatMap((e) => e.lines), entries.map((e) => e.eventType)),
      })
    }
    const plan = await planPeriod(prisma, tenant.id, period)
    return NextResponse.json({
      period: period.key, label: period.label, closed: false, batchId: null, entryCount: plan.entries.length,
      goLive: plan.isGoLive, refusal: plan.refusal,
      reconciliation: { ...plan.reconciliation, mismatches: plan.reconciliation.mismatches.slice(0, 50) },
      controls: await controlsWithReferences(tenant.id, plan.controls),
      ...summarise(plan.entries.flatMap((e) => e.lines), plan.entries.map((e) => e.eventType)),
    })
  })
}
