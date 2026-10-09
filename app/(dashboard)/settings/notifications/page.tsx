import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId } from "@/lib/tenant"
import { Header } from "@/components/layout/Header"
import { NotificationsSettingsClient, type EditableChannel } from "./NotificationsSettingsClient"

// Only events backed by a MessageTemplate row belong here. The reminder_* events
// were listed but have no row of their own and no consumer that reads one:
// lib/collections/reminders.ts composes that copy in TRIGGERS[].getMessage() and
// always dispatches through the payment_reminder_* templates. A trigger's
// noteType never drives template lookup — it only labels the LoanNote and the
// idempotency key — so listing those events here invited the false inference
// that editing one changed a reminder, or that a missing row meant silence.
const DEFAULT_EVENTS: Array<{ event: string; label: string; channels: EditableChannel[] }> = [
  { event: "loan_approved", label: "Loan Approved", channels: ["SMS", "EMAIL"] },
  { event: "loan_disbursed", label: "Loan Disbursed", channels: ["SMS", "EMAIL"] },
  { event: "loan_overdue", label: "Loan Overdue", channels: ["SMS", "EMAIL"] },
  { event: "payment_received", label: "Payment Received", channels: ["SMS", "EMAIL"] },
  { event: "section129_sent", label: "Section 129 Notice Sent", channels: ["EMAIL"] },
]

export default async function NotificationsSettingsPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  // The WABA editor's API sits at ADMIN. Gate the tab on the same hierarchy
  // check the route uses, or a LOAN_ADMIN gets a full editor that 403s on save.
  const canEditWaba = hasMinRole(user.role, "ADMIN")

  // Must be the SAME resolver the WABA route reaches through withTenantContext.
  // A bare findFirst({status:"ACTIVE"}) picks an arbitrary tenant, so with more
  // than one active tenant this page would list another tenant's template
  // bodies, Meta names and provider ids — and saving one would copy that
  // content into the caller's own tenant.
  const tenantId = await getResolvedTenantId()
  // findFirst + status, not findUnique: the previous query filtered on ACTIVE
  // and a suspended tenant must keep rendering nothing rather than its settings.
  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, status: "ACTIVE" } })
  if (!tenant) return null

  const templates = await prisma.messageTemplate.findMany({
    where: { tenantId: tenant.id },
  })

  const recentLogs = await prisma.notificationLog.findMany({
    where: { tenantId: tenant.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  })

  return (
    <>
      <Header
        title="Settings"
        subtitle="Notification templates & SMS reminders"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Notifications" },
        ]}
      />
      <NotificationsSettingsClient
        defaultEvents={DEFAULT_EVENTS}
        canEditWaba={canEditWaba}
        wabaTemplates={templates
          .filter((t) => t.channel === "WHATSAPP")
          .sort((a, b) => a.event.localeCompare(b.event))
          .map((t) => ({
            id: t.id,
            event: t.event,
            wabaTemplateName: t.wabaTemplateName,
            language: t.language,
            category: t.category,
            headerContent: t.headerContent,
            bodyTemplate: t.bodyTemplate,
            footer: t.footer,
            buttons: t.buttons,
            active: t.active,
            providerStatus: t.providerStatus,
            providerTemplateId: t.providerTemplateId,
          }))}
        templates={templates
          // Type predicate, not a bare filter: `.filter()` does not narrow, so a
          // plain cast below would silently start lying if this list widened.
          .filter((t): t is typeof t & { channel: EditableChannel } =>
            t.channel === "SMS" || t.channel === "EMAIL")
          .map((t) => ({
          ...t,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        }))}
        recentLogs={recentLogs.map((l) => ({
          ...l,
          createdAt: l.createdAt.toISOString(),
        }))}
      />
    </>
  )
}
