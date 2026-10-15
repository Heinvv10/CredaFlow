import { NextRequest } from "next/server"
import { parseValuation } from "@/lib/asset-finance/asset-input"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { invalidBody, recoveryResponse, withRecoveryStaff } from "@/lib/asset-finance/recovery-route"
import { recordRecoveryValuation } from "@/lib/asset-finance/recovery-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRecoveryStaff(req, "manage_asset_finance", async (actor) => {
    const { id } = await params
    const parsed = parseValuation(await req.json().catch(() => null), sastCalendarDate(new Date()))
    // An s127 recovery reuses its surrender's valuation, so it takes no body; every other route records a new valuation.
    if ("errors" in parsed) {
      const s127 = await prisma.recovery.count({ where: { id, tenantId: actor.tenantId, route: "NCA_S127_SURRENDER" } })
      if (s127 !== 1) return invalidBody(parsed.errors)
      return recoveryResponse(await recordRecoveryValuation(actor, id, { valuedOn: "", source: "ASSESSOR", valuerName: "", amountCents: 0 }))
    }
    const { valuedOn, source, valuerName, amountCents } = parsed.data
    return recoveryResponse(await recordRecoveryValuation(actor, id, { valuedOn, source, valuerName, amountCents }))
  })
}
