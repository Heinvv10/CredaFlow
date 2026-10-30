import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { auth } from "@/lib/auth"
import {
  QUARTER_RE,
  listSelectableQuarters,
  parseQuarterParam,
} from "@/lib/compliance/quarters"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import {
  getNcrReturnData,
  ncrSubmissionKey,
  submissionSnapshot,
} from "@/lib/compliance/ncr-return"

/**
 * NCR quarterly return.
 *
 * GET returns the same figures the page renders, for the same quarter, from
 * `lib/compliance/ncr-return.ts`. It previously ran its own all-time
 * aggregates, so an API consumer and the screen disagreed about the return.
 *
 * POST records a submission for a named quarter. It replaces a PATCH that took
 * an arbitrary ComplianceRecord id: no id is accepted now, so the class of bug
 * where a caller flips some other statutory row to SUBMITTED cannot be
 * expressed. Submission is idempotent per quarter, freezes the figures as
 * filed, and writes an audit row.
 */

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("The NCR quarterly return")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    try {
      const quarter = parseQuarterParam(
        req.nextUrl.searchParams.get("quarter") ?? undefined,
      )
      return NextResponse.json(await getNcrReturnData(tenant.id, quarter))
    } catch (error) {
      console.error("NCR return fetch failed:", error)
      return NextResponse.json({ error: "Failed to fetch NCR data" }, { status: 500 })
    }
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("The NCR quarterly return")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => ({}))) as { quarter?: string }
    const quarter = body.quarter ?? ""

    if (!QUARTER_RE.test(quarter) || !listSelectableQuarters().includes(quarter)) {
      return NextResponse.json(
        { error: "Invalid or out-of-range quarter" },
        { status: 400 },
      )
    }

    try {
      const existing = await prisma.complianceRecord.findFirst({
        where: {
          tenantId: tenant.id,
          type: "NCR_QUARTERLY_RETURN",
          status: "SUBMITTED",
          data: { path: ["quarter"], equals: quarter },
        },
      })

      if (existing) {
        return NextResponse.json({
          id: existing.id,
          submittedAt: existing.completedAt,
          alreadySubmitted: true,
        })
      }

      const session = await auth()
      const userId = session?.user?.id ?? null
      const userEmail = session?.user?.email ?? null

      // Freeze what was filed. Every PAR/arrears figure is read from mutable
      // current-state columns, so without this the record could never answer
      // "what numbers did we send the NCR" once the book moved.
      const data = await getNcrReturnData(tenant.id, quarter)

      // findFirst-then-create is check-then-act: two concurrent submissions for
      // one quarter would both pass the check and write two SUBMITTED rows into
      // a statutory register. `idempotencyKey` is already `@unique` on this
      // model — the column exists precisely for non-repeatable compliance
      // actions — so the database refuses the second write and no migration is
      // needed. The key carries the tenant because the constraint is global.
      const idempotencyKey = ncrSubmissionKey(tenant.id, quarter)

      let record: { id: string; completedAt: Date | null }
      try {
        record = await prisma.complianceRecord.create({
          data: {
            tenantId: tenant.id,
            type: "NCR_QUARTERLY_RETURN",
            status: "SUBMITTED",
            completedAt: new Date(),
            idempotencyKey,
            data: { quarter, submittedByUserId: userId, snapshot: submissionSnapshot(data) },
          },
        })
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError
          && error.code === "P2002"
        ) {
          // Lost the race. Return the winner rather than a 500, and write no
          // second audit row — only one submission happened.
          const winner = await prisma.complianceRecord.findUnique({
            where: { idempotencyKey },
            select: { id: true, completedAt: true },
          })
          if (winner) {
            return NextResponse.json({
              id: winner.id,
              submittedAt: winner.completedAt,
              alreadySubmitted: true,
            })
          }
        }
        throw error
      }

      await logAudit({
        tenantId: tenant.id,
        userId: userId ?? undefined,
        userEmail: userEmail ?? undefined,
        action: "NCR_RETURN_SUBMITTED",
        entity: "ComplianceRecord",
        entityId: record.id,
        newValue: { quarter },
      })

      // Housekeeping, deliberately AFTER the audit row: if this throws, the
      // handler 500s while the SUBMITTED record persists, and the retry hits
      // the `existing` short-circuit above and returns early — so an audit
      // written after this point would never be written at all, leaving a
      // statutory submission with no evidence.
      //
      // A PENDING row for the same quarter would otherwise linger forever: it
      // counts as an open statutory obligation against the health score, and
      // the table's Submit action can never clear it now that submission
      // creates its own row rather than updating one.
      await prisma.complianceRecord.updateMany({
        where: {
          tenantId: tenant.id,
          type: "NCR_QUARTERLY_RETURN",
          status: "PENDING",
          data: { path: ["quarter"], equals: quarter },
        },
        data: { status: "SUBMITTED", completedAt: record.completedAt },
      })

      return NextResponse.json({
        id: record.id,
        submittedAt: record.completedAt,
        alreadySubmitted: false,
      })
    } catch (error) {
      console.error("NCR return submission failed:", error)
      return NextResponse.json({ error: "Failed to record submission" }, { status: 500 })
    }
  })
}
