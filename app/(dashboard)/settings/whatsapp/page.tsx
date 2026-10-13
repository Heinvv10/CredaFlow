import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { getCommsSettings, WA_PROVIDERS } from "@/lib/inbox/settings"
import { listWaBridgeNumbers } from "@/lib/whatsapp-bridge-admin"
import { PUBLIC_COMMS_SETTINGS_SELECT } from "@/lib/inbox/comms-select"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { WhatsAppSettingsClient } from "./WhatsAppSettingsClient"

export default async function WhatsAppSettingsPage() {
  // Test-send endpoint is ADMIN-only (app/api/settings/whatsapp/test).
  // Page must match so a LOAN_ADMIN doesn't see config they can't act on.
  await requireMinRole("ADMIN")

  const waEnabled = process.env.WA_ENABLED === "true"
  // Deliberately NOT defaulted to lib/whatsapp.ts's fallback host. This value
  // is rendered to staff as a statement of where their messages go; printing a
  // borrowed third-party bridge as "ours" is a false claim, and it hides the
  // very misconfiguration the bridge monitor now alerts on.
  const waSenderUrl = process.env.WA_SENDER_URL ?? null

  // Server Component — outside the request-scoped tenant ALS frame, so the
  // tenantId filter below must be explicit (see feedback_tenant_scoped_writes_
  // need_runwithtenant). MessageTemplate isn't in TENANT_SCOPED_MODELS anyway,
  // but the explicit where keeps this cross-tenant-safe regardless.
  const tenantId = await getStaffTenantId()
  // Independent reads — issued together so the page costs one round trip.
  // The connection status uses PUBLIC_COMMS_SETTINGS_SELECT, whose type makes
  // naming a sealed credential column a compile error. getCommsSettings is a
  // separate read because it upserts the row and returns the whole model: only
  // the four non-sealed channel toggles below are ever handed to the client.
  const [wabaTemplates, comms, settings, waBridgeNumbers] = await Promise.all([
    prisma.messageTemplate.findMany({
      where: { tenantId, wabaTemplateName: { not: null } },
      select: { id: true, wabaTemplateName: true, providerStatus: true },
    }),
    prisma.commsSettings.findUnique({
      where: { tenantId },
      select: PUBLIC_COMMS_SETTINGS_SELECT,
    }),
    getCommsSettings(tenantId),
    // Short bound: this runs on every page load inside a server-rendered
    // Promise.all, so a bridge that's up-but-unresponsive must degrade to
    // the tab's "unreachable" state quickly instead of stalling the whole
    // WhatsApp Settings page for the full 15s default -- the very screen an
    // operator needs when the bridge is down.
    listWaBridgeNumbers({ timeoutMs: 5_000 }).catch(() => null), // null = "bridge unreachable", not "zero numbers"
  ])

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "WhatsApp" },
        ]}
      />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">WhatsApp Settings</h1>
        <p className="text-sm text-gray-400 mt-0.5">Status, the official Cloud API connection, bridge numbers, and notification templates</p>
      </div>
      <WhatsAppSettingsClient
        waEnabled={waEnabled}
        waSenderUrl={waSenderUrl}
        wabaTemplates={wabaTemplates}
        wabaPhoneNumberId={comms?.wabaPhoneNumberId}
        providers={[...WA_PROVIDERS]}
        waBridgeNumbers={waBridgeNumbers}
        channel={{
          whatsappEnabled: settings.whatsappEnabled,
          botsEnabled: settings.botsEnabled,
          chatAlertEmail: settings.chatAlertEmail,
          waProvider: settings.waProvider,
        }}
      />
    </div>
  )
}
