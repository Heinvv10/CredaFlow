import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { Ifrs9RunError, executeRun } from "@/lib/ifrs9/run"
import { listRuns, loadRunReport } from "@/lib/ifrs9/run-report"

// GET: LOAN_ADMIN. ?runId=&compareTo= returns the staging summary and the transition matrix of that run (default: the
// latest, against the one before it); no runId also lists the recent runs.
// POST { kind: "ON_DEMAND" }: ADMIN, TOTP when required. An on-demand run describes today and is analysis only: it never
// feeds the ledger or a later stage. The month's official run is made by the cron, or added late / superseded through
// POST /api/ifrs9/runs/monthly.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const params = req.nextUrl.searchParams
    const report = await loadRunReport(prisma, tenant.id, params.get("runId") ?? undefined, params.get("compareTo") ?? undefined)
    return NextResponse.json({ runs: await listRuns(prisma, tenant.id), report })
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "run IFRS 9 staging")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as { kind?: unknown }
    if (body.kind === "MONTHLY") return NextResponse.json({ error: "A monthly run is made by the month-end job; add a late one or supersede one with POST /api/ifrs9/runs/monthly" }, { status: 400 })
    if (body.kind !== "ON_DEMAND") return NextResponse.json({ error: "kind must be ON_DEMAND" }, { status: 400 })
    try {
      const run = await executeRun(tenant.id, { kind: "ON_DEMAND", actor: guard.user })
      return NextResponse.json(run, { status: 201 })
    } catch (error) {
      if (error instanceof Ifrs9RunError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "PARAMETERS_MISSING" ? 409 : 400 })
      throw error
    }
  })
}
