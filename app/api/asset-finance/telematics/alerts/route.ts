import { NextRequest, NextResponse } from "next/server"
import type { TelematicsAlertQueue, TelematicsAlertStatus } from "@prisma/client"
import { ALERT_QUEUES, ALERT_STATUSES, listAlerts } from "@/lib/telematics/alerts"
import { withTelematicsStaff } from "@/lib/telematics/route"

/** The tracker alert work queue (work_telematics_alerts): `?queue=COLLECTIONS|RECOVERY&status=OPEN|ACKNOWLEDGED|RESOLVED`, unresolved by default. */
export async function GET(req: NextRequest) {
  return withTelematicsStaff(req, "work_telematics_alerts", async ({ tenantId }) => {
    const params = req.nextUrl.searchParams
    const queue = params.get("queue")
    const status = params.get("status")
    if ((queue && !ALERT_QUEUES.includes(queue as TelematicsAlertQueue)) || (status && !ALERT_STATUSES.includes(status as TelematicsAlertStatus))) {
      return NextResponse.json({ error: "queue is COLLECTIONS or RECOVERY; status is OPEN, ACKNOWLEDGED or RESOLVED" }, { status: 400 })
    }
    const alerts = await listAlerts(tenantId, { queue: (queue as TelematicsAlertQueue) ?? undefined, status: (status as TelematicsAlertStatus) ?? undefined })
    return NextResponse.json({ alerts })
  })
}
