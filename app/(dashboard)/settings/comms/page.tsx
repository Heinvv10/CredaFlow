import { redirect } from "next/navigation"
import { requireMinRole } from "@/lib/auth-guards"
import { getDefaultTenantId } from "@/lib/tenant"
import { getCommsSettings } from "@/lib/inbox/settings"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { listStaffForRoster } from "@/lib/inbox/roster"
import { Header } from "@/components/layout/Header"
import { CommsSettingsClient } from "./CommsSettingsClient"

export default async function CommsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab } = await searchParams
  await requireMinRole("ADMIN")

  // Server-side redirect for the legacy ?tab=wa-bridge deep link (bookmarks,
  // typed URLs) — the client-side legacyTabRedirect effect below still
  // covers client-side navigation, but a server redirect avoids ever
  // rendering this page's DB-backed content for a tab that no longer exists.
  if (tab === "wa-bridge") redirect("/settings/whatsapp?tab=bridge")

  const tenantId = await getDefaultTenantId()
  const [settings, canned, roster] = await Promise.all([
    getCommsSettings(tenantId),
    listCannedReplies(tenantId),
    listStaffForRoster(tenantId),
  ])

  return (
    <>
      <Header
        title="Comms Hub Settings"
        subtitle="Out-of-hours auto-reply, business hours, canned replies, and the agent roster. WhatsApp channel switches and bridge numbers live under Settings → WhatsApp."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Comms Hub" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl">
        <CommsSettingsClient
          cannedReplies={canned.map((c) => ({ id: c.id, title: c.title, body: c.body }))}
          roster={roster}
          initial={{
            autoReplyEnabled: settings.autoReplyEnabled,
            autoReplyText: settings.autoReplyText ?? "",
            businessHours: (settings.businessHours as Record<string, unknown> | null) ?? null,
          }}
        />
      </div>
    </>
  )
}
