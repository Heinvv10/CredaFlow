import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { ASSET_FINANCE_ROLES, IFRS9_ROLES } from "@/lib/accounting/accounts"
import { parsePeriodKey } from "@/lib/accounting/period"
import { lockAccounting, readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { loadAccountMap, loadSettings } from "@/lib/accounting/store"

// Accounting export settings (lib/accounting). GET: LOAN_ADMIN.
// PUT { goLiveMonth?, vatRegistered?, vatRateBps? } and
// POST { action: "confirm_mapping" }: ADMIN, TOTP when required, audited.
// The go-live month is fixed once a month has closed.

const view = async (tenantId: string) => {
  const s = await loadSettings(prisma, tenantId)
  return { ...s, mappingConfirmedAt: s.mappingConfirmedAt?.toISOString() ?? null }
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await view(tenant.id)))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the accounting settings")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    if (typeof read.body !== "object" || read.body === null || Array.isArray(read.body)) {
      return NextResponse.json({ error: "The body must be a JSON object." }, { status: 400 })
    }
    const body = read.body as Record<string, unknown>
    const data: { goLiveMonth?: string | null; vatRegistered?: boolean; vatRateBps?: number } = {}
    if ("goLiveMonth" in body) {
      if (body.goLiveMonth !== null && !parsePeriodKey(body.goLiveMonth)) return NextResponse.json({ error: "goLiveMonth must be yyyy-mm" }, { status: 400 })
      data.goLiveMonth = body.goLiveMonth as string | null
    }
    if ("vatRegistered" in body) {
      if (typeof body.vatRegistered !== "boolean") return NextResponse.json({ error: "vatRegistered must be true or false" }, { status: 400 })
      data.vatRegistered = body.vatRegistered
    }
    if ("vatRateBps" in body) {
      if (!Number.isInteger(body.vatRateBps) || (body.vatRateBps as number) < 0 || (body.vatRateBps as number) > 10_000) {
        return NextResponse.json({ error: "vatRateBps must be a whole number of basis points, 0-10000 (15% = 1500)" }, { status: 400 })
      }
      data.vatRateBps = body.vatRateBps as number
    }
    const done = await prisma.$transaction(async (tx) => {
      // Under the close lock: the count of closed months is still true when the go-live month is written.
      await lockAccounting(tx, tenant.id)
      if ("goLiveMonth" in data && (await tx.accountingExportBatch.count({ where: { tenantId: tenant.id } })) > 0) return false
      const before = await tx.accountingSettings.findUnique({ where: { tenantId: tenant.id } })
      await tx.accountingSettings.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, ...data, updatedById: guard.user.id }, update: { ...data, updatedById: guard.user.id } })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.ACCOUNTING_SETTINGS_UPDATED,
        entity: "AccountingSettings", entityId: tenant.id,
        oldValue: before ? { goLiveMonth: before.goLiveMonth, vatRegistered: before.vatRegistered, vatRateBps: before.vatRateBps } : null,
        newValue: data,
      }, tx)
      return true
    })
    if (!done) return NextResponse.json({ error: "The go-live month is fixed once a month has closed" }, { status: 409 })
    return NextResponse.json(await view(tenant.id))
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "confirm the account mapping")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    if ((read.body as { action?: unknown } | null)?.action !== "confirm_mapping") {
      return NextResponse.json({ error: "action must be confirm_mapping" }, { status: 400 })
    }
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      // Under the lock the mapping PUT takes too: what is confirmed is the mapping as it is when the confirmation is written.
      await lockAccounting(tx, tenant.id)
      const map = await loadAccountMap(tx, tenant.id)
      await tx.accountingSettings.upsert({
        where: { tenantId: tenant.id },
        create: { tenantId: tenant.id, mappingConfirmedAt: now, mappingConfirmedById: guard.user.id, mappingConfirmedRoles: [...ASSET_FINANCE_ROLES, ...IFRS9_ROLES], updatedById: guard.user.id },
        update: { mappingConfirmedAt: now, mappingConfirmedById: guard.user.id, mappingConfirmedRoles: [...ASSET_FINANCE_ROLES, ...IFRS9_ROLES], updatedById: guard.user.id },
      })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.ACCOUNTING_MAPPING_CONFIRMED,
        entity: "AccountingSettings", entityId: tenant.id,
        // What was confirmed: every role's code, default or not.
        newValue: { mapping: Object.values(map).map(({ role, code, taxCode, vatInclusive, isDefault }) => ({ role, code, taxCode, vatInclusive, isDefault })) },
      }, tx)
    })
    return NextResponse.json(await view(tenant.id))
  })
}
