import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import {
  getFscaReturnData,
  fscaSubmissionKey,
  fscaSubmissionSnapshot,
} from "@/lib/fsca-return"
import { listSelectableQuarters, QUARTER_RE } from "@/lib/compliance/quarters"
import { auth } from "@/lib/auth"

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const notNca = ncaOnlyRefusal("The FSCA return")
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

    const existing = await prisma.complianceRecord.findFirst({
      where: {
        tenantId: tenant.id,
        type: "FSCA_QUARTERLY_RETURN",
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

    // Freeze the figures as filed, the same way the NCR return does. Without
    // this the record is a bare SUBMITTED flag: policy counts, claims and
    // complaint buckets are all recomputed from live rows, so a filed quarter
    // becomes unreconstructable the moment a policy lapses or a claim is
    // settled. The quarter's SAST boundary also shifted when the bounds moved
    // off UTC midnight, which changes what a recompute returns at the edges.
    const filed = await getFscaReturnData(tenant.id, quarter)

    const idempotencyKey = fscaSubmissionKey(tenant.id, quarter)

    let record: { id: string; completedAt: Date | null }
    try {
      record = await prisma.complianceRecord.create({
        data: {
          tenantId: tenant.id,
          type: "FSCA_QUARTERLY_RETURN",
          status: "SUBMITTED",
          completedAt: new Date(),
          idempotencyKey,
          data: {
            quarter,
            submittedByUserId: userId,
            snapshot: fscaSubmissionSnapshot(filed),
          },
        },
      })
    } catch (error) {
      // Mirrors the NCR handler. Adding a unique reservation key without
      // catching P2002 would turn a concurrent double-submit — which used to
      // write two rows and return 200 — into an unhandled 500, because this
      // route has no try/catch of its own and withTenantContext does not catch
      // either.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === "P2002"
      ) {
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
      action: "FSCA_RETURN_SUBMITTED",
      entity: "ComplianceRecord",
      entityId: record.id,
      newValue: { quarter },
    })

    return NextResponse.json({
      id: record.id,
      submittedAt: record.completedAt,
      alreadySubmitted: false,
    })
  })
}
