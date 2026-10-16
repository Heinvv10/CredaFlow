import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { decideDeal, parseDecideInput } from "@/lib/asset-finance/deal-decision"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"
import { borrowerScreeningGate, isScreeningRefusal } from "@/lib/screening/gate"

/**
 * The credit decision on a SUBMITTED or REFERRED deal (decide_asset_finance;
 * lib/asset-finance/deal-decision.ts). Body:
 * `{ decision: "APPROVE" | "DECLINE" | "REFER", reasons: string[], exceptionReason?: string }`
 * — at least one reason, each at least 5 characters, for every decision.
 *
 * APPROVE needs a credit memo. NCA deals additionally need a recorded,
 * affordable s81 assessment and reckless-lending note; the database repeats
 * that gate. A pending NON_NCA override is decided before approval. A deal
 * with exceptions (internal arrears, a bureau check not on record) needs
 * `exceptionReason` and `exceptionsShown` (the sentences it answers): 409
 * listing them when missing or when they changed (audited refusal).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const refuse = async (reason: string, status: number, error: string) => {
      await auditRefusal({
        action: AuditAction.ASSET_DEAL_DECISION_REFUSED,
        entity: "AssetFinanceDeal",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status,
      })
      return NextResponse.json({ error }, { status })
    }
    if (!canDo(guard.user.role, "decide_asset_finance")) {
      return refuse("insufficient_role", 403, "Deciding a deal needs the decide_asset_finance permission")
    }
    const input = parseDecideInput(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })

    // PEP / sanctions screening of the borrower before approval: the entity and
    // its related parties, or the natural person (lib/screening/gate.ts). It
    // re-screens a party that is unscreened, stale, errored or changed.
    if (input.decision === "APPROVE") {
      const deal = await prisma.assetFinanceDeal.findFirst({
        where: { id, tenantId: tenant.id },
        select: { applicationId: true, application: { select: { clientId: true, entityId: true } } },
      })
      if (deal) {
        const screening = await borrowerScreeningGate({
          tenantId: tenant.id,
          borrower: deal.application,
          applicationId: deal.applicationId,
          actor: { id: guard.user.id, email: guard.user.email },
        })
        if (!screening.allowed) {
          return refuse(screening.selfDecided ? "screening_self_decided" : `screening_${screening.state.state.toLowerCase()}`, 422, `Approval blocked: ${screening.message}`)
        }
      }
    }

    let result: Awaited<ReturnType<typeof decideDeal>>
    try {
      result = await prisma.$transaction((tx) =>
        decideDeal(tx, { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, input),
      )
    } catch (error) {
      if (isScreeningRefusal(error)) {
        return refuse("screening_changed", 422, "Approval blocked: the borrower's screening changed while approving. Review it and try again.")
      }
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The database refused the decision; the deal changed, try again" }, { status: 409 })
      }
      throw error
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_decidable":
        return NextResponse.json({ error: `A ${result.status} deal cannot be decided` }, { status: 409 })
      case "awaiting_override":
        return refuse("awaiting_regime_approval", 409, "The NON_NCA override awaits a second approver")
      case "memo_required":
        return refuse("credit_memo_required", 409, "Record the credit memo before approving")
      case "assessment_required":
        return refuse("s81_assessment_required", 409, "Record the NCA s81 affordability assessment before approving")
      case "unaffordable":
        return refuse("s81_unaffordable", 409, "The recorded NCA s81 assessment is not affordable")
      case "credit_life_required":
        return refuse("credit_life_required", 409, "The borrower must accept or decline the credit-life offer before approval")
      case "screening_blocked":
        return refuse("screening_changed", 422, "Approval blocked: the borrower's screening changed while approving. Review it and try again.")
      case "exceptions_changed":
        return refuse("exceptions_changed", 409, `The exceptions changed since the page was loaded; review them and decide again: ${result.exceptions.join("; ")}`)
      case "exception_reason_without_exceptions":
        return refuse("exception_reason_without_exceptions", 422, "The deal has no exceptions to answer: decide without an exception reason")
      case "product_not_asset_finance":
        return refuse("product_not_asset_finance", 409, "The deal's product is not an asset-finance product")
      case "exceptions_unanswered":
        return refuse("exceptions_unanswered", 409, `Approving needs a reason for these exceptions: ${result.exceptions.join("; ")}`)
      case "refused_nca":
        return NextResponse.json({ error: result.reason, deal: await loadDealDetail(tenant.id, id) }, { status: 409 })
      case "decided":
        return NextResponse.json(await loadDealDetail(tenant.id, id))
    }
  })
}
