import { NextRequest } from "next/server"
import { badRequest, cents, isoDate, leaseStaffAction, text } from "@/lib/asset-finance/lease-route"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"

type Params = { params: Promise<{ loanId: string }> }

/** Record a meter reading of the leased asset (manage_asset_finance). Body: `{ readingDate, value, evidenceDocumentId? }`. */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leaseStaffAction(req, { loanId, permission: "manage_asset_finance", action: "meter_reading" }, (tx, actor, today, body) => {
    const readingDate = isoDate(body, "readingDate")
    const value = cents(body, "value")
    if (!readingDate || value === null) return Promise.resolve(badRequest("reading", "readingDate (YYYY-MM-DD) and value (a whole number) are required"))
    return recordMeterReading(tx, { tenantId: actor.tenantId, userId: actor.userId }, { loanId, readingDate, value, evidenceDocumentId: text(body, "evidenceDocumentId"), today })
  })
}
