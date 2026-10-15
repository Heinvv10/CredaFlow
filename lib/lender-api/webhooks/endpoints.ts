import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sealSecret } from "@/lib/crypto/secret-box"
import { generateWebhookSecret } from "@/lib/lender-api/webhooks/signing"
import { assertWebhookUrl, SsrfError, type Resolver } from "@/lib/lender-api/webhooks/ssrf"
import type { WebhookEventType } from "@/lib/lender-api/webhooks/events"

/**
 * Creating and disabling a tenant's webhook endpoints (Settings → API &
 * webhooks). Both write their audit row in the same transaction as the
 * change. The signing secret is returned once, on creation, and stored only
 * sealed with WEBHOOK_SECRET_KEY.
 */

export const MAX_ACTIVE_ENDPOINTS = 10

export function webhookSecretKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.WEBHOOK_SECRET_KEY?.trim() || null
}

interface Actor { id: string; email: string; ipAddress?: string }

export type CreateEndpointOutcome =
  | { ok: true; endpoint: { id: string; url: string; events: string[]; secretPrefix: string }; secret: string }
  | { ok: false; status: 400 | 409 | 503; error: string }

export async function createWebhookEndpoint(
  args: { tenantId: string; actor: Actor; url: string; description: string | null; events: WebhookEventType[] },
  resolve?: Resolver,
): Promise<CreateEndpointOutcome> {
  const key = webhookSecretKey()
  if (!key) return { ok: false, status: 503, error: "Webhooks are not configured on this server (WEBHOOK_SECRET_KEY)." }
  let url: URL
  try {
    url = await assertWebhookUrl(args.url, resolve)
  } catch (error) {
    if (!(error instanceof SsrfError)) throw error
    // One answer for every refusal: naming the address a host resolved to, or
    // telling "private" from "does not resolve" from "timed out", would let the
    // form be used to map the internal network. The detail is logged here only.
    console.warn("[webhooks] endpoint URL refused", { tenantId: args.tenantId, reason: error.message })
    return { ok: false, status: 400, error: "Webhook URL refused: use an https URL whose host resolves only to public internet addresses." }
  }
  const secret = generateWebhookSecret()
  return prisma.$transaction(async (tx) => {
    const active = await tx.webhookEndpoint.count({ where: { tenantId: args.tenantId, active: true } })
    if (active >= MAX_ACTIVE_ENDPOINTS) {
      return { ok: false as const, status: 409 as const, error: `At most ${MAX_ACTIVE_ENDPOINTS} active endpoints.` }
    }
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        tenantId: args.tenantId,
        url: url.toString(),
        description: args.description,
        events: args.events,
        secretSealed: sealSecret(secret, key),
        secretPrefix: secret.slice(0, 10),
        createdById: args.actor.id,
      },
      select: { id: true, url: true, events: true, secretPrefix: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id,
      userEmail: args.actor.email,
      action: AuditAction.WEBHOOK_ENDPOINT_CREATED,
      entity: "WebhookEndpoint",
      entityId: endpoint.id,
      newValue: { url: endpoint.url, events: endpoint.events, secretPrefix: endpoint.secretPrefix },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return { ok: true as const, endpoint, secret }
  })
}

export async function disableWebhookEndpoint(args: { tenantId: string; actor: Actor; endpointId: string }): Promise<"disabled" | "not_found" | "already_disabled"> {
  return prisma.$transaction(async (tx) => {
    const now = new Date()
    const { count } = await tx.webhookEndpoint.updateMany({
      where: { id: args.endpointId, tenantId: args.tenantId, active: true },
      data: { active: false, disabledAt: now, disabledById: args.actor.id },
    })
    if (count === 0) {
      const exists = await tx.webhookEndpoint.findFirst({ where: { id: args.endpointId, tenantId: args.tenantId }, select: { id: true } })
      return exists ? "already_disabled" : "not_found"
    }
    await logAuditStrict({
      tenantId: args.tenantId,
      userId: args.actor.id,
      userEmail: args.actor.email,
      action: AuditAction.WEBHOOK_ENDPOINT_DISABLED,
      entity: "WebhookEndpoint",
      entityId: args.endpointId,
      newValue: { disabledAt: now.toISOString() },
      ipAddress: args.actor.ipAddress,
    }, tx)
    return "disabled"
  })
}
