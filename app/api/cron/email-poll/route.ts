import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { pollTenantInbox } from "@/lib/email/inbound-poll"

/**
 * Inbound email poll cron.
 *
 * Sweeps every tenant with an active EmailConfig and matches customer email
 * replies (identified by the X-Lms-Ref header) back to their loan —
 * marking the EmailLog REPLIED + dropping a LoanNote. Replaces the previously
 * manual "Poll Inbox" button so replies are captured without a human.
 *
 * Cadence: every few minutes via the systemd timer that hits /api/cron/* with
 * X-Cron-Secret. The IMAP fetch spans the last 7 days and every write is
 * idempotent-by-effect (EmailLog SENT→REPLIED once; a duplicate LoanNote is
 * the only cost of re-processing), so overlapping runs are safe.
 *
 * NOTE: it polls the mailbox configured in Settings → Email (imapUser). For it
 * to catch replies sent to the Reply-To address (support@), that mailbox must
 * be the one polled — set the IMAP user to support@, or forward support@ into
 * the polled mailbox.
 *
 * Cross-tenant: runs under withoutTenantScope; the poll uses explicit
 * where:{tenantId} for every write.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await withoutTenantScope(async () => {
    const configs = await prisma.emailConfig.findMany({ where: { active: true } })
    const perTenant: Array<{ tenantId: string; ok: boolean; checked?: number; matched?: number; message?: string }> = []
    let totalChecked = 0
    let totalMatched = 0
    for (const config of configs) {
      const r = await pollTenantInbox(config, config.tenantId)
      perTenant.push({ tenantId: config.tenantId, ...r })
      totalChecked += r.checked ?? 0
      totalMatched += r.matched ?? 0
    }
    return { tenants: configs.length, totalChecked, totalMatched, perTenant }
  })

  // A per-tenant poll failure must surface as ok:false AND as a non-2xx status.
  // A hardcoded ok:true here reported 1,966 consecutive IMAP TLS failures as
  // successful runs, so inbound email was dead in production for weeks without
  // any alert firing. The body alone is not enough: the systemd wrapper invokes
  // this with `curl -fsS`, which only fails the unit on HTTP >= 400 and never
  // parses the JSON. Returning 200 with ok:false would still exit 0 and keep the
  // outage invisible.
  //
  // Each outcome is ALSO persisted to EmailConfig.lastPollAt/lastPollOk/
  // lastPollError inside pollTenantInbox, so the failure is visible on
  // /settings/email even to someone who never sees this response body.
  const ok = result.perTenant.every((t) => t.ok)

  return NextResponse.json(
    { ok, ranAt: new Date().toISOString(), ...result },
    { status: ok ? 200 : 503 },
  )
}
