import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { missingDefaults, parseParameterInput } from "@/lib/ifrs9/parameters"
import { loadParameters, replaceParameters } from "@/lib/ifrs9/store"

// The PD/LGD table (basis points). GET: LOAN_ADMIN. PUT { parameters: [...] } replaces the whole
// table and must hold the lender default for every stage: ADMIN, TOTP when required, audited.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json({ parameters: await loadParameters(prisma, tenant.id) }))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the IFRS 9 parameters")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const parsed = parseParameterInput(read.body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const missing = missingDefaults(parsed.rows)
    if (missing.length > 0) {
      return NextResponse.json({ error: `The table needs the DEFAULT scope for stage ${missing.join(", ")}: it covers every loan no more specific row does` }, { status: 400 })
    }
    await replaceParameters(prisma, tenant.id, parsed.rows, guard.user)
    return NextResponse.json({ parameters: await loadParameters(prisma, tenant.id) })
  })
}
