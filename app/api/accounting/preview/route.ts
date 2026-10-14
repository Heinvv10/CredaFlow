import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { ACCOUNT_ROLES, DEFAULT_ACCOUNTS } from "@/lib/accounting/accounts"
import { derivePeriod } from "@/lib/accounting/generate"
import { parsePeriodKey } from "@/lib/accounting/period"
import type { DerivedEntry } from "@/lib/accounting/derive"

// What a month's journals would be (or are, once closed): totals per account
// and per event type. Read-only; LOAN_ADMIN.

function summarise(entries: DerivedEntry[]) {
  const accounts = new Map<string, { role: string; accountCode: string; debitCents: number; creditCents: number }>()
  const events = new Map<string, number>()
  for (const e of entries) {
    events.set(e.eventType, (events.get(e.eventType) ?? 0) + 1)
    for (const l of e.lines) {
      const key = `${l.role}|${l.accountCode}`
      const row = accounts.get(key) ?? { role: l.role, accountCode: l.accountCode, debitCents: 0, creditCents: 0 }
      row.debitCents += l.debitCents
      row.creditCents += l.creditCents
      accounts.set(key, row)
    }
  }
  const order = (role: string) => (ACCOUNT_ROLES as readonly string[]).indexOf(role)
  return {
    accounts: [...accounts.values()]
      .sort((a, b) => order(a.role) - order(b.role) || a.accountCode.localeCompare(b.accountCode))
      .map((a) => ({ ...a, name: DEFAULT_ACCOUNTS[a.role as keyof typeof DEFAULT_ACCOUNTS]?.name ?? a.role })),
    events: Object.fromEntries([...events.entries()].sort()),
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const period = parsePeriodKey(req.nextUrl.searchParams.get("period"))
    if (!period) return NextResponse.json({ error: "period must be yyyy-mm" }, { status: 400 })
    const closed = await prisma.accountingExportBatch.findFirst({
      where: { tenantId: tenant.id, periodKey: period.key },
      select: { id: true },
    })
    if (closed) {
      const lines = await prisma.accountingJournalLine.findMany({
        where: { tenantId: tenant.id, batchId: closed.id },
        select: { role: true, accountCode: true, debitCents: true, creditCents: true, taxCode: true, entry: { select: { eventType: true, eventKey: true } } },
      })
      const byEntry = new Map<string, DerivedEntry>()
      for (const l of lines) {
        const entry = byEntry.get(l.entry.eventKey) ?? ({ eventType: l.entry.eventType, lines: [] } as unknown as DerivedEntry)
        entry.lines.push({ role: l.role as DerivedEntry["lines"][number]["role"], accountCode: l.accountCode, taxCode: l.taxCode, debitCents: l.debitCents, creditCents: l.creditCents })
        byEntry.set(l.entry.eventKey, entry)
      }
      const entries = [...byEntry.values()]
      const debit = lines.reduce((s, l) => s + l.debitCents, 0)
      const credit = lines.reduce((s, l) => s + l.creditCents, 0)
      return NextResponse.json({ period: period.key, label: period.label, closed: true, batchId: closed.id, entryCount: entries.length, debitCents: debit, creditCents: credit, ...summarise(entries) })
    }
    const { entries, totals } = await derivePeriod(prisma, tenant.id, period)
    return NextResponse.json({
      period: period.key, label: period.label, closed: false, batchId: null, entryCount: totals.entryCount,
      debitCents: Number(totals.debitCents), creditCents: Number(totals.creditCents), ...summarise(entries),
    })
  })
}
