import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { statusAfterAutoDecision } from "@/lib/decisioning/run-safely"
import { startApplicationReview } from "./review-application"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const started = await startApplicationReview({ tenant, user: guard.user, id, autoDecisionTrigger: "REVIEW_STARTED" })
      if (started instanceof Response) return started
      const { autoDecision } = started

      if (req.headers.get("accept")?.includes("application/json")) {
        return NextResponse.json({
          ok: true,
          id,
          status: autoDecision ? statusAfterAutoDecision(autoDecision) : "UNDER_REVIEW",
          bureauResult: started.bureauResult,
          bureauReviewRetried: started.bureauReviewRetried,
          ...(autoDecision?.status === "RAN" ? { autoDecision: { execution: autoDecision.execution, decision: autoDecision.verdict.decision, reasonCodes: autoDecision.verdict.reasonCodes, riskGrade: autoDecision.verdict.riskGrade } } : {}),
        })
      }

      const forwardedProto = req.headers.get("x-forwarded-proto")
      const forwardedHost = req.headers.get("x-forwarded-host")
      const fallback = new URL(req.url)
      const redirectBase = forwardedHost
        ? `${forwardedProto ?? fallback.protocol.replace(":", "")}://${forwardedHost}`
        : fallback.origin

      return NextResponse.redirect(new URL(`/applications/${id}`, redirectBase), 303)
    })
  } catch (error) {
    console.error("Failed to start review:", error)
    return NextResponse.json(
      { error: "Failed to start review" },
      { status: 500 },
    )
  }
}
