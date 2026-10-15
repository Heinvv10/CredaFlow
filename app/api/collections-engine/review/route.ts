import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { resolveReviewItem, type ReviewAction } from "@/lib/collections-engine/review"
import { mandateErrorResponse } from "@/lib/collections-engine/http"

const ALLOWED: Record<ReviewAction["kind"], readonly string[]> = {
  INSTRUCTION: ["MARK_SUBMITTED", "RELEASE", "ACKNOWLEDGE"],
  RESULT: ["ACKNOWLEDGE"],
  MANDATE: ["RETRY", "ACKNOWLEDGE"],
}

/**
 * POST /api/collections-engine/review
 * Body: { kind: "INSTRUCTION" | "RESULT" | "MANDATE", id, action, reason }
 *
 * Resolves one collections-engine review item (lib/collections-engine/review.ts).
 * LOAN_ADMIN; audited; 409 while the engine is off or the item is not waiting.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    const kind = body?.kind as ReviewAction["kind"] | undefined
    const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
    if (!kind || !(kind in ALLOWED) || typeof body?.id !== "string" || typeof body.action !== "string"
      || !ALLOWED[kind].includes(body.action) || !reason || reason.length > 500) {
      return NextResponse.json({ error: "kind, id, a valid action and a reason of up to 500 characters are required" }, { status: 422 })
    }
    try {
      await resolveReviewItem(tenant.id, { userId: guard.user.id, userEmail: guard.user.email },
        {
          kind, id: body.id, action: body.action, confirmedNotSent: body.confirmedNotSent === true,
          paymentId: typeof body.paymentId === "string" && body.paymentId ? body.paymentId : undefined,
          noMoneyReceived: body.noMoneyReceived === true,
          amountOverrideReason: typeof body.amountOverrideReason === "string" ? body.amountOverrideReason.slice(0, 500) : undefined,
        } as ReviewAction, reason)
      return NextResponse.json({ ok: true })
    } catch (error) {
      const mapped = mandateErrorResponse(error)
      if (mapped) return mapped
      throw error
    }
  })
}
