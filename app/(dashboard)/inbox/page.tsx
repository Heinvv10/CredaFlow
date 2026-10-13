import { Header } from "@/components/layout/Header"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireCommsAgentPage } from "@/lib/inbox/authz"
import { listConversations, resolveQueueForConversation, getConversationSummary, type InboxQueue } from "@/lib/inbox/conversations"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { listStaffForRoster } from "@/lib/inbox/roster"
import { InboxClient } from "./InboxClient"
import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { messageReconciliationCandidateWhere } from "@/lib/messaging/reconciliation"
import { hasMinRole } from "@/lib/auth-guards"

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ conversationId?: string }> }) {
  const user = await requireCommsAgentPage()
  const tenantId = await getStaffTenantId()
  const now = new Date()
  const { conversationId } = await searchParams
  const canReconcile = hasMinRole(user.role, "LOAN_ADMIN")

  const resolvedQueue = conversationId
    ? await resolveQueueForConversation({ tenantId, conversationId, agentUserId: user.id })
    : null
  const initialQueue: InboxQueue = resolvedQueue ?? "unassigned"

  const [list, canned, roster, reconciliationCount] = await Promise.all([
    listConversations({ tenantId, queue: initialQueue, agentUserId: user.id }),
    listCannedReplies(tenantId),
    listStaffForRoster(tenantId),
    canReconcile
      ? prisma.message.count({
          where: {
            tenantId,
            status: "QUEUED",
            ...messageReconciliationCandidateWhere(now),
          },
        })
      : Promise.resolve(0),
  ])

  let initialConversations = list.conversations
  let initialSelectedId: string | null = null
  if (conversationId && resolvedQueue) {
    if (list.conversations.some((c) => c.id === conversationId)) {
      initialSelectedId = conversationId
    } else {
      // Exists (tenant-scoped, same authz path as the queue fetch) but ranks
      // beyond the page — pin it at the top instead of silently no-oping.
      const pinned = await getConversationSummary({ tenantId, conversationId })
      if (pinned) {
        initialConversations = [pinned, ...list.conversations]
        initialSelectedId = conversationId
      }
    }
  }

  return (
    // AppShell's <main> compensates for the fixed h-14 topbar via pt-14 (3.5rem)
    // padding — that's the one genuinely fixed quantity in this layout. Header
    // height and the reconciliation banner (conditional) are NOT fixed, so
    // don't bake them into a height constant: stack them in a flex column and
    // let the inbox grid claim whatever's left via flex-1/min-h-0. That keeps
    // the composer on-screen regardless of banner presence or header height.
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="shrink-0">
        <Header title="Inbox" subtitle="Inbox — claim, reply, and resolve customer conversations across WhatsApp and email" />
      </div>
      {reconciliationCount > 0 ? (
        <div className="mx-6 mt-4 shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{reconciliationCount} message{reconciliationCount === 1 ? "" : "s"}</strong> require provider reconciliation and cannot retry automatically.{" "}
          <Link href="/inbox/reconciliation" className="font-semibold underline">Open queue</Link>
        </div>
      ) : null}
      <InboxClient
        currentUserId={user.id}
        canReconcile={canReconcile}
        canReleaseChats={hasMinRole(user.role, "ADMIN")}
        initialQueue={initialQueue}
        initialSelectedId={initialSelectedId}
        initialConversations={initialConversations}
        cannedReplies={canned.map((c) => ({ id: c.id, title: c.title, body: c.body }))}
        roster={roster}
      />
    </div>
  )
}
