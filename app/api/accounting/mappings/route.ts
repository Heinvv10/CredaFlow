import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { ACCOUNT_ROLES, DEFAULT_ACCOUNTS, parseMappingInput } from "@/lib/accounting/accounts"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { loadAccountMap } from "@/lib/accounting/store"

// The tenant's chart-of-accounts mapping. GET: LOAN_ADMIN. PUT: ADMIN, TOTP
// when required, audited. A change applies to months closed after it; closed
// months keep the codes they were exported with. Any change withdraws the
// lender's confirmation of the mapping: no month closes until it is confirmed again.

async function view(tenantId: string) {
  const map = await loadAccountMap(prisma, tenantId)
  return ACCOUNT_ROLES.map((role) => ({ ...map[role], description: DEFAULT_ACCOUNTS[role].description, defaultCode: DEFAULT_ACCOUNTS[role].code }))
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json({ mappings: await view(tenant.id) }))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the chart-of-accounts mapping")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const parsed = parseMappingInput(read.body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    await prisma.$transaction(async (tx) => {
      const before = await tx.accountingAccountMapping.findMany({ where: { tenantId: tenant.id }, select: { role: true, accountCode: true, taxCode: true, vatInclusive: true } })
      for (const row of parsed.rows) {
        await tx.accountingAccountMapping.upsert({
          where: { tenantId_role: { tenantId: tenant.id, role: row.role } },
          create: { tenantId: tenant.id, ...row, updatedById: guard.user.id },
          update: { accountCode: row.accountCode, accountName: row.accountName, taxCode: row.taxCode, vatInclusive: row.vatInclusive, updatedById: guard.user.id },
        })
      }
      await tx.accountingSettings.updateMany({ where: { tenantId: tenant.id }, data: { mappingConfirmedAt: null, mappingConfirmedById: null, mappingConfirmedRoles: [] } })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: AuditAction.ACCOUNTING_MAPPING_UPDATED, entity: "AccountingAccountMapping", entityId: tenant.id,
        oldValue: { mappings: before }, newValue: { mappings: parsed.rows.map(({ role, accountCode, taxCode, vatInclusive }) => ({ role, accountCode, taxCode, vatInclusive })), confirmationWithdrawn: true },
      }, tx)
    })
    return NextResponse.json({ mappings: await view(tenant.id) })
  })
}
