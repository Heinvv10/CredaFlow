import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { MessageReconciliationAction } from "@/components/messaging/MessageReconciliationAction"
import { messageReconciliationCandidateWhere } from "@/lib/messaging/reconciliation"
import { SAST_TIME_ZONE } from "@/lib/utils"

const HARD_CAP = 200

function contactName(contact: { firstName: string | null; lastName: string | null }): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unknown contact"
}

export default async function MessageReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ messageId?: string }>
}) {
  // Match POST /api/messaging/reconciliation/[id]'s LOAN_ADMIN hierarchy.
  // Resolving legal delivery uncertainty is a loan-admin duty and must not
  // depend on the separate inbox-agent roster flag.
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  const { messageId } = await searchParams
  const now = new Date()
  const messages = await prisma.message.findMany({
    where: {
      tenantId,
      status: "QUEUED",
      ...messageReconciliationCandidateWhere(now),
      ...(messageId ? { id: messageId } : {}),
    },
    include: {
      conversation: {
        select: {
          contact: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: [{ lastErrorAt: "asc" }, { id: "asc" }],
    take: HARD_CAP,
  })

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs items={[{ label: "Inbox", href: "/inbox" }, { label: "Message reconciliation" }]} />
      <div className="my-6">
        <h1 className="text-2xl font-bold text-[#1b1d24]">Message reconciliation</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600">
          These messages are deliberately excluded from automatic retry because the provider outcome is unknown, a known outcome could not reach the terminal message state, or a worker&apos;s bounded dispatch lease expired. Check provider logs before recording an outcome.
        </p>
      </div>
      {messages.length === 0 ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          No messages currently require reconciliation.
        </div>
      ) : (
        <div className="grid gap-4">
          {messages.map((message) => (
            <article key={message.id} className="rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-gray-900">{contactName(message.conversation.contact)}</p>
                  <p className="text-xs text-gray-600">
                    {message.channel} via {message.provider} · {message.toValue ?? "destination unavailable"}
                  </p>
                </div>
                <div className="text-right text-xs text-gray-600">
                  <p className="font-mono">{message.id}</p>
                  <p>{(message.lastErrorAt ?? message.createdAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}</p>
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap rounded-lg bg-white/80 p-3 text-sm text-gray-800">
                {message.bodyText ?? "No message body retained"}
              </p>
              <p className="mt-2 text-xs font-medium text-amber-900">{message.errorMessage}</p>
              <MessageReconciliationAction
                messageId={message.id}
                dispatchState={message.dispatchState}
                provider={message.provider}
                knownProviderMessageId={message.dispatchProviderMessageId}
                knownProviderAcceptedAt={message.dispatchProviderAcceptedAt?.toISOString() ?? null}
                knownSimulationReceiptId={message.simulationReceiptId}
              />
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
