import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { generateDaily, generateMonthly } from "@/lib/bureau-submission/generate"
import { dayEnd, isDay, isMonthEnd } from "@/lib/bureau-submission/period"
import { isBureauSubmissionEnabled } from "@/lib/bureau-submission/staff-view.server"
import { BureauError, BureauFileError } from "@/lib/bureau-submission/validate"

/**
 * Staff-triggered generation of a bureau file for review.
 *
 * ALWAYS in TEST mode, whatever BUREAU_SUBMISSION_MODE says: a LIVE ledger row
 * records what the bureau was told and makes a closing status un-sendable
 * again, so only the scheduled job may write one. A TEST file is the same
 * bytes with a T702 file name and can be regenerated freely.
 *
 * LOAN_ADMIN, like the download: generating maps every client's ID number.
 * The generator writes the audit row in the same transaction as the ledger.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard

  return withTenantContext(req, async (tenant) => {
    if (!(await isBureauSubmissionEnabled(tenant.id))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    const body = (await req.json().catch(() => ({}))) as { kind?: unknown; period?: unknown }
    const period = typeof body.period === "string" ? body.period : ""
    const now = new Date()
    if (body.kind !== "DAILY" && body.kind !== "MONTHLY") {
      return NextResponse.json({ error: "kind must be DAILY or MONTHLY" }, { status: 400 })
    }
    if (!isDay(period)) return NextResponse.json({ error: "period must be YYYY-MM-DD" }, { status: 400 })
    if (dayEnd(period) > now) return NextResponse.json({ error: "That period has not ended yet" }, { status: 400 })
    if (body.kind === "MONTHLY" && !isMonthEnd(period)) {
      return NextResponse.json({ error: "A monthly file is for the last day of a month" }, { status: 400 })
    }

    const args = { tenantId: tenant.id, mode: "TEST" as const, now, actor: { source: "staff" as const, userId: user.id, userEmail: user.email } }
    try {
      const result = body.kind === "MONTHLY"
        ? await generateMonthly(prisma, { ...args, periodDay: period })
        : await generateDaily(prisma, { ...args, day: period })
      return NextResponse.json(result)
    } catch (error) {
      if (error instanceof BureauFileError) {
        return NextResponse.json({ error: "The file failed structural validation and was not generated", errors: error.errors }, { status: 422 })
      }
      // The module's own refusals (a concurrent run, an exhausted sequence) are safe to show.
      if (error instanceof BureauError) return NextResponse.json({ error: error.message }, { status: 409 })
      // Never echo an unknown error: a database message can quote row values.
      console.error("Bureau submission generation failed:", error instanceof Error ? error.name : "unknown")
      return NextResponse.json({ error: "Generation failed" }, { status: 500 })
    }
  })
}
