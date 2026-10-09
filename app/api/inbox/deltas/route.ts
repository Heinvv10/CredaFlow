import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { getInboxDeltas } from "@/lib/inbox/realtime"
import type { InboxQueue } from "@/lib/inbox/conversations"

const QUEUES: InboxQueue[] = ["unassigned", "mine", "all", "closed"]
function parseQueue(v: string | null): InboxQueue {
  return QUEUES.includes(v as InboxQueue) ? (v as InboxQueue) : "unassigned"
}

export async function GET(req: NextRequest) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const url = new URL(req.url)
    const result = await getInboxDeltas({
      tenantId: tenant.id,
      agentUserId: guard.user.id,
      queue: parseQueue(url.searchParams.get("queue")),
      since: url.searchParams.get("since"),
    })
    return NextResponse.json(result)
  })
}
