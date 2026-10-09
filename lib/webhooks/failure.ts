import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import type { WebhookProvider, VerifyFailureReason } from "./verify"

export type WriteWebhookSignatureFailureOpts = {
  provider: WebhookProvider
  reason: VerifyFailureReason
  pathname: string
  rawBody: string
  rawHeaders: Record<string, string>
  sourceIp: string | null
  tenantId: string | null
}

export type WebhookSignatureFailureRow = {
  id: string
}

/**
 * Persist a webhook-signature failure for forensic + breach-audit purposes.
 *
 * NEVER stores the raw body — only `sha256(rawBody)`. Per the schema comment
 * on `WebhookSignatureFailure`: "we don't persist unverified payloads".
 * The hash is enough to correlate a failure with a re-delivery + spot a
 * replay attempt, without piling unverified attacker-controlled bodies into
 * our DB.
 *
 * Emits a `WEBHOOK_SIGNATURE_FAILED` audit row carrying the persisted id +
 * provider + reason so a single audit feed gives ops the breadcrumb chain.
 *
 * The audit's `tenantId` is only set when the caller had already resolved a
 * tenant for the request (eg. URL-embedded tenant slug). For most webhook
 * traffic that hasn't been authenticated yet, both the row's `tenantId` and
 * the audit's `tenantId` will be null/omitted — consistent with the schema's
 * nullable tenantId.
 */
export async function writeWebhookSignatureFailure(
  opts: WriteWebhookSignatureFailureOpts
): Promise<WebhookSignatureFailureRow> {
  const rawBodySha256 = createHash("sha256").update(opts.rawBody).digest("hex")

  const row = await prisma.webhookSignatureFailure.create({
    data: {
      tenantId: opts.tenantId,
      provider: opts.provider,
      sourceIp: opts.sourceIp,
      pathname: opts.pathname,
      reason: opts.reason,
      rawHeaders: opts.rawHeaders,
      rawBodySha256,
    },
  })

  await logAudit({
    tenantId: opts.tenantId ?? undefined,
    action: "WEBHOOK_SIGNATURE_FAILED",
    entity: "WebhookSignatureFailure",
    entityId: row.id,
    newValue: {
      provider: opts.provider,
      reason: opts.reason,
      pathname: opts.pathname,
      sourceIp: opts.sourceIp,
      rawBodySha256,
    },
    ipAddress: opts.sourceIp ?? undefined,
  })

  return { id: row.id }
}
