import { NextRequest, NextResponse } from "next/server"
import { sastCalendarDate } from "@/lib/date/sast"
import { withPayoutStaff } from "@/lib/asset-finance/payout-route"
import { bookDeal } from "@/lib/asset-finance/booking"
import { loadPayoutPanel } from "@/lib/asset-finance/payout-view"

// Refusals that mean "the deal is not in the state booking needs" (409);
// the rest mean "these terms cannot be booked as they stand" (422).
const STATE_CONFLICTS = new Set([
  "already_booked", "not_contracted", "application_not_ready", "no_payout", "payout_not_approved",
  "account_not_approved", "asset_changed", "terms_changed", "not_prepared",
])

/**
 * Books a CONTRACTED deal whose payout is APPROVED (decide_asset_finance), in
 * one transaction: Loan, schedule, booking ContractRate, tax invoice,
 * application DISBURSED, deal BOOKED, payout RELEASED
 * (lib/asset-finance/booking.ts). The loan starts on the planned start date
 * fixed when the documents were prepared; today (SAST) is the booking and
 * invoice date. Terms that no longer solve to the signed instalment, interest
 * and rate are refused (409 terms_changed). A refusal or a lost race (409)
 * writes nothing and is audited.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPayoutStaff(req, { dealId: id, permission: "decide_asset_finance" }, async ({ tenantId, user, refuse }) => {
    const result = await bookDeal({ tenantId, userId: user.id, userEmail: user.email }, id, sastCalendarDate(new Date()))
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "refused":
        return refuse(result.reason, STATE_CONFLICTS.has(result.reason) ? 409 : 422, result.error)
      case "booked":
        return NextResponse.json({ ...result, panel: await loadPayoutPanel(tenantId, id) }, { status: 201 })
    }
  })
}
