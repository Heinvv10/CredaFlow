import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { Bell } from "lucide-react"
import { NotificationTabs } from "./NotificationTabs"
import { getPortalTenantId } from "@/lib/session-tenant"
import { SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"

const EVENT_LABELS: Record<string, string> = {
  PAYMENT_REMINDER: "Payment reminder",
  PAYMENT_RECEIVED: "Payment received",
  PAYMENT_CONFIRMATION: "Payment confirmed",
  AGREEMENT_GENERATED: "Agreement ready",
  AGREEMENT_SIGNED: "Agreement signed",
  LOAN_APPROVED: "Loan approved",
  LOAN_DISBURSED: "Loan disbursed",
  LOAN_APPLICATION_RECEIVED: "Application received",
  LOAN_APPLICATION_APPROVED: "Application approved",
  LOAN_APPLICATION_DECLINED: "Application declined",
  DOCUMENT_UPLOADED: "Document uploaded",
  DOCUMENT_VERIFIED: "Document verified",
  DOCUMENT_REJECTED: "Document rejected",
  KYC_VERIFIED: "Identity verified",
  KYC_FAILED: "Identity check failed",
  SECTION_129_NOTICE: "Section 129 notice",
  WELCOME: "Welcome message",
  OVERDUE_NOTICE: "Overdue notice",
  INSURANCE_CREATED: "Insurance policy created",
}

interface NotificationItem {
  id: string
  event: string
  channel: string
  status: string
  error: string | null
  createdAt: Date
}

export default async function NotificationsPage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getPortalTenantId()

  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    select: { id: true },
  })

  let notifications: NotificationItem[] = []

  if (client) {
    const rows = await prisma.notificationLog.findMany({
      where: { tenantId, clientId: client.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        event: true,
        channel: true,
        status: true,
        error: true,
        createdAt: true,
      },
    })

    // A leg we skipped because the LENDER has that channel switched off is an
    // internal operating fact, not something that happened to the borrower.
    // The row stays in NotificationLog for the audit trail; it just isn't
    // shown here, where it would render as a red "Blocked" line against an
    // event that did reach them by email and WhatsApp.
    //
    // Excluded on the exact reason, not on status alone: `blocked` also
    // carries consent suppression and "No WhatsApp on file", which are facts
    // about the borrower's own record and must keep showing.
    //
    // Filtered HERE rather than as a Prisma `NOT`, and the difference is not
    // stylistic. `NOT (status = 'blocked' AND error = <const>)` is SQL, so a
    // row whose `error` IS NULL makes the inner AND evaluate to NULL, `NOT
    // NULL` is NULL, and a NULL predicate filters the row OUT — a future
    // `blocked` write that forgot to give a reason would silently vanish from
    // a borrower's own history. Every current writer supplies a non-empty
    // reason (lib/notifications.ts), but that is an invariant nobody enforces.
    // In JS `n.error === <const>` is simply false for null, so a reasonless
    // row is KEPT. The wrong outcome here is hiding a record from the person
    // it is about, so the comparison must fail towards showing it.
    //
    // Costs nothing: this query has no take/skip, so the rows were being
    // fetched either way.
    notifications = rows.filter(
      (n) => !(n.status === "blocked" && n.error === SMS_CHANNEL_OFF_REASON),
    )
  }

  const serialized = notifications.map((n) => ({
    id: n.id,
    event: n.event,
    eventLabel: EVENT_LABELS[n.event] || n.event.replace(/_/g, " ").toLowerCase(),
    channel: n.channel,
    status: n.status,
    error: n.error,
    createdAt: n.createdAt.toISOString(),
  }))

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8">
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: "#4338CA20" }}
        >
          <Bell className="w-5 h-5" style={{ color: "#4338CA" }} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-[var(--cf-text)]">Notifications</h1>
          <p className="text-sm text-[var(--cf-text-muted)]">
            History of all communications sent to you
          </p>
        </div>
      </div>

      <NotificationTabs items={serialized} />
    </div>
  )
}
