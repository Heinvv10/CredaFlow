import { requireMinRole, hasMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { prisma } from "@/lib/prisma"
import { formatDateTime } from "@/lib/utils"
import { apiKeyState, keyIssuerStillAuthorised } from "@/lib/lender-api/keys"
import { Header } from "@/components/layout/Header"
import { ApiKeysCard } from "@/components/settings/ApiKeysCard"
import { WebhookEndpointsCard } from "@/components/settings/WebhookEndpointsCard"

export const metadata = {
  title: "API & webhooks — Settings",
}

export default async function ApiSettingsPage() {
  // Visible to ADMIN and above; changes also need a TOTP-verified session
  // (lib/lender-api/settings-guard.ts).
  const user = await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const canManage = hasMinRole(user.role, "ADMIN") && user.totpVerified === true

  const [keys, endpoints, deliveries] = await Promise.all([
    prisma.apiKey.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, prefix: true, scopes: true, createdAt: true, expiresAt: true,
        lastUsedAt: true, revokedAt: true, createdBy: { select: { email: true, active: true, role: true } },
      },
    }),
    prisma.webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      select: { id: true, url: true, description: true, events: true, secretPrefix: true, active: true, createdAt: true, pausedAt: true, pausedReason: true, consecutiveFailures: true },
    }),
    prisma.webhookDelivery.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, status: true, attempts: true, lastResponseStatus: true, lastError: true, createdAt: true, nextAttemptAt: true,
        event: { select: { type: true } }, endpoint: { select: { url: true } },
      },
    }),
  ])

  return (
    <>
      <Header
        title="API & webhooks"
        subtitle="Let other systems read this lender's book and be told when things change."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "API & webhooks" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-5xl space-y-6">
        <ApiKeysCard
          canManage={canManage}
          keys={keys.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            scopes: k.scopes,
            // A key whose creator is no longer an active ADMIN stops working (lib/lender-api/handler.ts).
            state: apiKeyState(k) === "active" && !keyIssuerStillAuthorised(k.createdBy) ? "suspended" : apiKeyState(k),
            createdBy: k.createdBy.email,
            createdAt: formatDateTime(k.createdAt),
            expiresAt: formatDateTime(k.expiresAt),
            lastUsedAt: k.lastUsedAt ? formatDateTime(k.lastUsedAt) : null,
          }))}
        />
        <WebhookEndpointsCard
          canManage={canManage}
          endpoints={endpoints.map((e) => ({ ...e, createdAt: formatDateTime(e.createdAt), pausedAt: e.pausedAt ? formatDateTime(e.pausedAt) : null }))}
          deliveries={deliveries.map((d) => ({
            id: d.id,
            eventType: d.event.type,
            endpointUrl: d.endpoint.url,
            status: d.status,
            attempts: d.attempts,
            lastResponseStatus: d.lastResponseStatus,
            lastError: d.lastError,
            createdAt: formatDateTime(d.createdAt),
            nextAttemptAt: d.status === "PENDING" ? formatDateTime(d.nextAttemptAt) : null,
          }))}
        />
      </div>
    </>
  )
}
