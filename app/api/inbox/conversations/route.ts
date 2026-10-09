import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { listConversations, type InboxQueue } from "@/lib/inbox/conversations"

const QUEUES: InboxQueue[] = ["unassigned", "mine", "all", "closed"]
function parseQueue(v: string | null): InboxQueue {
  return QUEUES.includes(v as InboxQueue) ? (v as InboxQueue) : "unassigned"
}

function parseLimit(v: string | null): number | undefined {
  if (!v) return undefined
  const n = Number.parseInt(v, 10)
  return Math.min(100, Math.max(1, Number.isNaN(n) ? 30 : n))
}

export async function GET(req: NextRequest) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const url = new URL(req.url)
    const result = await listConversations({
      tenantId: tenant.id,
      queue: parseQueue(url.searchParams.get("queue")),
      agentUserId: guard.user.id,
      limit: parseLimit(url.searchParams.get("limit")),
      cursor: url.searchParams.get("cursor") ?? undefined,
    })
    return NextResponse.json(result)
  })
}
