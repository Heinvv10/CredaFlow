import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { nextStatuses } from "@/lib/insurance/quote/lifecycle"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { id } = await params

      // Tenant-scoped: another tenant's quote is a 404, not a 403.
      const quote = await prisma.insuranceQuote.findFirst({
        where: { id, tenantId: tenant.id },
        // EXPLICIT SELECT, not `include`.
        //
        // This handler answers a READONLY caller — the widest role in the
        // module. `include` shipped every InsuredLife column, so the idNumber
        // and date of birth of a client's spouse, children and parents went to
        // anyone who could read a quote. Those people are not clients, never
        // applied for anything, and in most cases have no relationship with
        // the lender at all; `InsuredLife` carries free-text identity precisely
        // because of that. Minimising what leaves here is the POPIA position,
        // and an `include` silently re-widens every time a column is added.
        //
        // idNumber is deliberately ABSENT. The POPIA subject-access index on
        // it exists so staff can FIND these rows when a person asks; that is a
        // different act, with a different lawful basis, from listing them on a
        // quote screen.
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          productId: true,
          advisorId: true,
          quoteNumber: true,
          status: true,
          rateTableId: true,
          totalPremium: true,
          totalSumAssured: true,
          eligibilityResult: true,
          ratingFailures: true,
          effectiveDate: true,
          expiresAt: true,
          convertedPolicyId: true,
          disclosuresIssued: true,
          createdAt: true,
          updatedAt: true,
          lives: {
            orderBy: [{ lifeType: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              clientId: true,
              firstName: true,
              lastName: true,
              relationship: true,
              lifeType: true,
              dateOfBirth: true,
              sumAssured: true,
              premiumAmount: true,
              rateBandId: true,
              waitingPeriodEnds: true,
              status: true,
            },
          },
          adviceRecord: {
            select: {
              id: true,
              needsAnalysis: true,
              productsConsidered: true,
              recommendation: true,
              clientDecision: true,
              reasonIfDifferent: true,
              pdfUrl: true,
              contentHash: true,
              recordedById: true,
              recordedAt: true,
            },
          },
          product: { select: { id: true, code: true, name: true, type: true } },
          rateTable: { select: { id: true, version: true, name: true, basis: true, status: true } },
        },
      })
      if (!quote) {
        return NextResponse.json({ error: "Quote not found" }, { status: 404 })
      }

      // Computed rather than stored, so the UI never has to reimplement the
      // transition table — and never disagrees with the server about what is
      // permitted, which is how a button that 409s on every click gets shipped.
      return NextResponse.json({
        ...quote,
        allowedTransitions: nextStatuses(quote.status, {
          hasAdviceRecord: quote.adviceRecord !== null,
          // Same evidence the status route enforces on, so the UI is never
          // offered a transition the server would refuse.
          eligibilityPassed:
            typeof quote.eligibilityResult === "object"
            && quote.eligibilityResult !== null
            && (quote.eligibilityResult as { pass?: unknown }).pass === true,
          hasPrice: quote.totalPremium !== null,
        }),
      })
    })
  } catch (error) {
    // Third instance of the same defect the reviewer named in the other two
    // read handlers. This route has no write sibling to be inconsistent with,
    // which is precisely why it was missed — the reasoning is the read itself:
    // a 500 that leaves no trace is a production incident with no evidence.
    console.error("Failed to fetch quote:", error)
    return NextResponse.json({ error: "Failed to fetch quote" }, { status: 500 })
  }
}
