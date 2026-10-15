/**
 * Integration-suite helper: give a tenant its own Stitch webhook secret, the
 * way a lender's admin saves it (sealed, lib/integrations/tenant-credentials.ts).
 *
 * The STITCH_WEBHOOK_SECRET environment variable applies only on a
 * tenant ENV_CREDENTIALS_TENANT_SLUG names, so suites that post signed
 * webhooks store the secret per tenant.
 */
import type { PrismaClient } from "@prisma/client"
import { sealCredential } from "./tenant-credentials"

// Synthetic, test-only: 32 zero bytes. Set only when the run has no key.
const TEST_KEY = Buffer.alloc(32).toString("base64")

export async function storeStitchWebhookSecret(db: PrismaClient, tenantId: string, secret: string): Promise<void> {
  process.env.WABA_ENC_KEY ||= TEST_KEY
  const stitchWebhookSecret = sealCredential(secret)
  await db.tenantConfig.upsert({
    where: { tenantId },
    update: { stitchWebhookSecret },
    create: { tenantId, stitchWebhookSecret },
  })
}
