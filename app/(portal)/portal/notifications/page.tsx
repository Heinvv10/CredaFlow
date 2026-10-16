import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { Bell } from "lucide-react"
import { NotificationTabs } from "./NotificationTabs"
import { getPortalTenantId } from "@/lib/session-tenant"
import { borrowerNotificationStatus, hiddenFromBorrower } from "@/lib/portal/notification-status"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { getLocale } from "@/lib/i18n/server"
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate"
import { formatDayTime } from "@/lib/i18n/format"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { portalNotifications } from "@/lib/i18n/messages/en/portal-notifications"

type NotificationsKey = MessageKey<"portalNotifications">
const KEYS: ReadonlySet<string> = new Set(Object.keys(portalNotifications))

// Section 129 is an NCA notice: its label stays English in every locale.
const ENGLISH_EVENT_LABELS: Readonly<Record<string, string>> = {
  SECTION_129_NOTICE: "Section 129 notice",
  SECTION129_SENT: "section129 sent",
}

// NotificationLog.event is upper case from some writers and lower case from
// lib/notifications.ts; both name the same events.
function eventLabel(t: Translator<"portalNotifications">, event: string): string {
  const upper = event.toUpperCase()
  const english = ENGLISH_EVENT_LABELS[upper]
  if (english) return english
  const key = `ev_${upper}`
  return KEYS.has(key) ? t(key as NotificationsKey) : event.replace(/_/g, " ").toLowerCase()
}

// Formatted here, on the server, so the client list cannot render a different
// string from the server's (a browser without ICU data for the locale would).
function notificationDate(iso: Date, locale: Locale): string {
  if (locale !== DEFAULT_LOCALE) return formatDayTime(iso, locale)
  return iso.toLocaleDateString("en-ZA", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SAST_TIME_ZONE,
  })
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
    // The same applies to the WhatsApp channel being off and to a WhatsApp
    // leg suppressed because another reminder already sent one
    // (hiddenFromBorrower, lib/portal/notification-status.ts).
    notifications = rows.filter((n) => !hiddenFromBorrower(n))
  }

  const locale = await getLocale()
  const t = createTranslator(locale, "portalNotifications")
  const serialized = notifications.map((n) => ({
    id: n.id,
    event: n.event,
    eventLabel: eventLabel(t, n.event),
    channel: n.channel,
    // The borrower's view of the delivery, never the internal state or its
    // error text (lib/portal/notification-status.ts).
    status: borrowerNotificationStatus(n.status),
    createdAt: n.createdAt.toISOString(),
    createdAtLabel: notificationDate(n.createdAt, locale),
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
          <h1 className="text-xl font-bold text-[var(--cf-text)]">{t("title")}</h1>
          <p className="text-sm text-[var(--cf-text-muted)]">
            {t("subtitle")}
          </p>
        </div>
      </div>

      <NotificationTabs items={serialized} />
    </div>
  )
}
