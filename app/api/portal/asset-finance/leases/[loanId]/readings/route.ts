import { NextRequest } from "next/server"
import { badRequest, cents, isoDate, leasePortalAction } from "@/lib/asset-finance/lease-route"
import { recordMeterReading } from "@/lib/asset-finance/meter-readings"

type Params = { params: Promise<{ loanId: string }> }

/** The lessee submits a meter reading (portal; source PORTAL). Body: `{ readingDate, value }`. */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leasePortalAction(req, loanId, "portal_meter_reading", (tx, actor, today, body) => {
    const readingDate = isoDate(body, "readingDate")
    const value = cents(body, "value")
    if (!readingDate || value === null) return Promise.resolve(badRequest("reading", "readingDate (YYYY-MM-DD) and value (a whole number) are required"))
    return recordMeterReading(tx, actor, { loanId, readingDate, value, evidenceDocumentId: null, today })
  })
}
