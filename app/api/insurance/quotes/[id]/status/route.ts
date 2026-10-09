import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { QuoteStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { canTransition } from "@/lib/insurance/quote/lifecycle"
import { readJsonObject } from "../../../request-body"

const QUOTE_STATUSES = Object.values(QuoteStatus) as string[]

/**
 * Read `pass` out of the persisted `eligibilityResult` JSON.
 *
 * Anything that is not an object carrying `pass === true` is a FAIL. A column
 * that is null, malformed, or written by an older shape must never read as a
 * pass — an unreadable screen result is not a favourable one.
 */
function eligibilityPassed(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { pass?: unknown }).pass === true
}

/**
 * Move a quote to the next status.
 *
 * The transition table in `lib/insurance/quote/lifecycle.ts` is the authority;
 * this route only supplies the facts and turns a refusal into a 409. In
 * particular it never special-cases CONVERTED — the lifecycle refuses it here
 * because this is an "API" caller, and the bind path is the only thing entitled
 * to declare otherwise.
 *
 * The status is re-checked inside the UPDATE's own WHERE clause. The read above
 * it is the friendly rejection; the WHERE is the actual guard, because two
 * concurrent requests can both read QUOTED and both decide they may advance.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { id } = await params

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }

      const status = typeof parsedBody.body.status === "string" ? parsedBody.body.status : ""
      if (!QUOTE_STATUSES.includes(status)) {
        return NextResponse.json(
          { error: `status must be one of ${QUOTE_STATUSES.join(", ")}` },
          { status: 422 }
        )
      }
      const target = status as QuoteStatus

      const quote = await prisma.insuranceQuote.findFirst({
        where: { id, tenantId: tenant.id },
        select: {
          id: true,
          status: true,
          quoteNumber: true,
          // The quote's OWN evidence, read from the row and handed to the
          // transition table. Without these the lifecycle cannot tell a
          // sellable quote from one the insurer's terms refused.
          eligibilityResult: true,
          totalPremium: true,
          adviceRecord: { select: { id: true } },
        },
      })
      if (!quote) {
        return NextResponse.json({ error: "Quote not found" }, { status: 404 })
      }

      // WHY BOTH FACTS ARE PASSED, AND WHY `NOT_PRICED` AT THE BIND IS NOT
      // ENOUGH — read this before deciding either is redundant.
      //
      // The two draft reasons fail asymmetrically, and the asymmetry is what
      // hid this hole for as long as it did:
      //
      //   RATING_FAILED      -> totalPremium is NULL. The bind's NOT_PRICED
      //                         guard catches it, by accident rather than by
      //                         design.
      //   ELIGIBILITY_FAILED -> rating SUCCEEDED, so a premium IS present.
      //                         Nothing downstream catches it.
      //
      // So the case that slipped through was precisely the one where the
      // insurer's own captured terms refuse the lives — the failure with the
      // real money behind it. Reading `NOT_PRICED` in bind.ts and concluding
      // the state is covered is the exact mistake that was made here; it covers
      // one branch of two.
      //
      // `hasPrice` therefore does not duplicate NOT_PRICED, and
      // `eligibilityPassed` is the half that had no guard at all.
      const allowed = canTransition(quote.status, target, {
        hasAdviceRecord: quote.adviceRecord !== null,
        eligibilityPassed: eligibilityPassed(quote.eligibilityResult),
        hasPrice: quote.totalPremium !== null,
        via: "API",
      })
      if (!allowed.ok) {
        // Audited. A refused transition is an attempt to move a quote past a
        // control — most sharply, an attempt to reach SUBMITTED_TO_INSURER
        // without a record of advice — and an auditor asking whether the FAIS
        // gate ever fired needs a row that says it did.
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_QUOTE_TRANSITION_REFUSED,
          entity: "InsuranceQuote",
          entityId: quote.id,
          oldValue: { status: quote.status },
          newValue: { attempted: target, reason: allowed.reason, detail: allowed.detail },
        })
        return NextResponse.json({ error: allowed.detail, reason: allowed.reason }, { status: 409 })
      }

      // `updateMany` with the expected status in the WHERE clause: a count of 0
      // means someone else moved the quote between the read and the write, and
      // that is a 409 rather than a silent overwrite of their transition.
      const updated = await prisma.insuranceQuote.updateMany({
        where: { id: quote.id, tenantId: tenant.id, status: quote.status },
        data: { status: target },
      })
      if (updated.count === 0) {
        return NextResponse.json(
          { error: "The quote changed status concurrently, please retry", reason: "CONCURRENT_UPDATE" },
          { status: 409 }
        )
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_QUOTE_STATUS_CHANGED,
        entity: "InsuranceQuote",
        entityId: quote.id,
        oldValue: { status: quote.status },
        newValue: { status: target, quoteNumber: quote.quoteNumber },
      })

      return NextResponse.json({ id: quote.id, status: target })
    })
  } catch (error) {
    console.error("Failed to change quote status:", error)
    return NextResponse.json({ error: "Failed to change quote status" }, { status: 500 })
  }
}
