import { NextRequest, NextResponse } from "next/server"
import { badRequest, cents, isoDate, leaseStaffAction, text } from "@/lib/asset-finance/lease-route"
import { electEndOfTerm, endExtension, recordInspection } from "@/lib/asset-finance/lease-end-of-term"
import { confirmPurchaseNatis, invoiceEndOfTerm } from "@/lib/asset-finance/lease-end-invoice"

type Params = { params: Promise<{ loanId: string; action: string }> }

const OUTCOMES = ["RETURN", "EXTEND", "PURCHASE"] as const

/**
 * A lease's end of term (lib/asset-finance/lease-end-of-term.ts):
 *   elect             { outcome, purchasePriceExclVatCents?, valuationId? }   manage_asset_finance
 *   extension-notice  { noticeOn }                                            manage_asset_finance
 *   inspection        { inspectedOn, condition, finalReading?, damage: [{ description, amountExclVatCents }] }  manage_asset_finance
 *   invoice           {}  the end-of-term (or sale) tax invoice               decide_asset_finance
 *   natis-confirmed   {}  a purchased vehicle's eNaTIS change                 decide_asset_finance
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, action } = await params
  const decide = action === "invoice" || action === "natis-confirmed"
  if (!["elect", "extension-notice", "inspection", "invoice", "natis-confirmed"].includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 404 })
  return leaseStaffAction(req, { loanId, permission: decide ? "decide_asset_finance" : "manage_asset_finance", action: `end_of_term_${action}` }, (tx, actor, today, body) => {
    switch (action) {
      case "elect": {
        const outcome = OUTCOMES.find((o) => o === body.outcome)
        if (!outcome) return Promise.resolve(badRequest("outcome", "outcome must be RETURN, EXTEND or PURCHASE"))
        const price = cents(body, "purchasePriceExclVatCents")
        const valuationId = text(body, "valuationId")
        return electEndOfTerm(tx, actor, { loanId, outcome, today, purchase: price !== null && valuationId ? { priceExclVatCents: price, valuationId } : undefined })
      }
      case "extension-notice": {
        // Absent means today; a malformed date is refused, never replaced (the notice is fixed once given).
        const noticeOn = body.noticeOn === undefined ? today : isoDate(body, "noticeOn")
        if (!noticeOn) return Promise.resolve(badRequest("noticeOn", "noticeOn must be a date, YYYY-MM-DD"))
        return endExtension(tx, actor, { loanId, noticeOn, today })
      }
      case "inspection": {
        const inspectedOn = isoDate(body, "inspectedOn")
        const condition = text(body, "condition")
        const damage: unknown[] = Array.isArray(body.damage) ? body.damage : []
        const items = damage.map((d) => (typeof d === "object" && d !== null ? d as Record<string, unknown> : {}))
          .map((d) => ({ description: text(d, "description") ?? "", amountExclVatCents: cents(d, "amountExclVatCents") ?? 0 }))
        if (!inspectedOn || !condition) return Promise.resolve(badRequest("inspection", "inspectedOn and condition are required"))
        if (condition.length > 2_000 || damage.length > 50 || items.some((d) => d.description.length > 300)) {
          return Promise.resolve(badRequest("inspection", "At most 50 damage items; the condition and each description are kept short"))
        }
        return recordInspection(tx, actor, { loanId, inspectedOn, condition, finalReading: cents(body, "finalReading"), damage: items, today })
      }
      case "invoice": {
        const refund = typeof body.refund === "object" && body.refund !== null ? body.refund as Record<string, unknown> : null
        return invoiceEndOfTerm(tx, actor, { loanId, today, ...(refund ? { refund: { amountCents: cents(refund, "amountCents") ?? -1, paidOn: isoDate(refund, "paidOn") ?? "", reference: text(refund, "reference") ?? "", documentId: text(refund, "documentId") ?? "" } } : {}) })
      }
      default:
        return confirmPurchaseNatis(tx, actor, loanId)
    }
  })
}
