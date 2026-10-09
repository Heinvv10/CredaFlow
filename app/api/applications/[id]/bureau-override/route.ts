import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

const MIN_REASON_LENGTH = 10

// Compatibility endpoint retained for older clients that offered an in-place
// post-approval override. Immutable decision evidence makes that operation
// invalid: approved applications must be returned to review and approved again
// with the override captured by /decide.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("LOAN_ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id } = await ctx.params
      const body = await req.json() as { reason?: unknown }
      const reason = typeof body.reason === "string" ? body.reason.trim() : ""

      if (reason.length < MIN_REASON_LENGTH) {
        return NextResponse.json(
          { error: `Override reason must be at least ${MIN_REASON_LENGTH} characters.` },
          { status: 400 }
        )
      }

      const application = await prisma.loanApplication.findUnique({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true },
      })

      if (!application) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }

      if (application.status !== "APPROVED") {
        return NextResponse.json(
          { error: "Bureau override back-fill is only valid on APPROVED applications. For SUBMITTED / UNDER_REVIEW, supply `bureauOverrideReason` via /decide instead." },
          { status: 400 }
        )
      }

      // Never mutate decision evidence after approval. A post-approval
      // override would immediately invalidate the immutable approval snapshot
      // and could not lawfully unblock payout. The supported workflow archives
      // the approval first, then records any reasoned override during a fresh
      // approval through /decide.
      return NextResponse.json(
        {
          error: "Post-approval bureau evidence cannot be back-filled in place. Return the application to review, reassess it, and approve it again with a reasoned override.",
        },
        { status: 409 },
      )
    })
  } catch (error) {
    console.error("Failed to record bureau override:", error)
    return NextResponse.json(
      { error: "Failed to record bureau override" },
      { status: 500 }
    )
  }
}
