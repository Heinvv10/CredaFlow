import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { bindQuote, type BindRefusal } from "@/lib/insurance/policy/bind"
import { parseInsuranceDateInput } from "@/lib/insurance/parse-date-input"
import { readJsonObject } from "../../../request-body"

const REFUSAL_STATUS: Record<BindRefusal, number> = {
  QUOTE_NOT_FOUND: 404,
  ALREADY_CONVERTED: 409,
  NOT_BINDABLE: 409,
  NOT_PRICED: 409,
  NO_LIVES: 409,
  NOT_ELIGIBLE: 409,
  WAITING_PERIOD_INVALID: 409,
  START_DATE_OUT_OF_RANGE: 422,
  QUOTE_EXPIRED: 409,
  TOKEN_INVALID: 422,
  TOKEN_MISMATCH: 422,
  TOKEN_REPLAYED: 422,
}

/**
 * Bind an accepted quote to a policy.
 *
 * The body carries a `draftToken` and an optional `startDate` — and NOTHING
 * priced. Premium and sum assured are read from the quote inside `bindQuote`;
 * there is deliberately no parameter here through which a caller could name
 * their own figure, which is why this route does not parse one even to ignore
 * it. A body field that is never read cannot be accidentally wired up later.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
      const body = parsedBody.body

      const draftToken = typeof body.draftToken === "string" ? body.draftToken : ""
      if (!draftToken) {
        return NextResponse.json(
          { error: "draftToken is required — a policy cannot be bound without the FAIS disclosure presented to the client" },
          { status: 422 }
        )
      }

      // ONE instant for both the default start date and the judgement `now`.
      // `bindQuote` refuses `startDate < now`, and it used to stamp its own
      // `now` a moment after this line stamped `startDate` — so the ordinary
      // "bind, starting today" call was correct only while both landed in the
      // same millisecond. Pinning one instant makes them equal by construction.
      const now = new Date()
      // A date-only `startDate` naming today resolves to `now` for the same
      // reason it does at the quote seam — midnight is in the past, and cover
      // may not be backdated. See `parseInsuranceDateInput`.
      const startDate = body.startDate ? parseInsuranceDateInput(String(body.startDate), now) : now
      if (startDate === null) {
        return NextResponse.json({ error: "startDate is not a valid date" }, { status: 422 })
      }

      // Variance cast for the $extends client, as elsewhere in this module.
      const bindStore = prisma as unknown as PrismaClient

      const result = await bindQuote(bindStore, {
        tenantId: tenant.id,
        quoteId: id,
        draftToken,
        startDate,
        now,
        boundById: guard.user?.id ?? null,
      })

      if (!result.ok) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_QUOTE_BIND_REFUSED,
          entity: "InsuranceQuote",
          entityId: id,
          newValue: { reason: result.reason, detail: result.detail },
        })
        return NextResponse.json(
          { error: result.detail, reason: result.reason },
          { status: REFUSAL_STATUS[result.reason] }
        )
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_QUOTE_BOUND,
        entity: "InsurancePolicy",
        entityId: result.policyId,
        newValue: {
          quoteId: id,
          policyNumber: result.policyNumber,
          // The figures AS BOUND, from the quote. Recorded so an auditor can
          // see the policy was priced by the quote and not by the request.
          premiumAmount: result.premiumAmount,
          sumAssured: result.sumAssured,
          livesActivated: result.livesActivated,
        },
      })

      return NextResponse.json(
        {
          policyId: result.policyId,
          policyNumber: result.policyNumber,
          premiumAmount: result.premiumAmount,
          sumAssured: result.sumAssured,
          livesActivated: result.livesActivated,
        },
        { status: 201 }
      )
    })
  } catch (error) {
    console.error("Failed to bind quote:", error)
    return NextResponse.json({ error: "Failed to bind quote" }, { status: 500 })
  }
}
