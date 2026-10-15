import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runWebhookDeliveries } from "@/lib/lender-api/webhooks/dispatch"

/**
 * Every minute: fans new webhook outbox events out to their endpoints and
 * POSTs what is due, retrying with backoff (lib/lender-api/webhooks/dispatch.ts).
 * A failed delivery is not a failed run: it is recorded on its WebhookDelivery
 * row and retried. Only an error of the run itself answers 500.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const result = await runWebhookDeliveries()
  return NextResponse.json({ ok: true, ...result })
}
