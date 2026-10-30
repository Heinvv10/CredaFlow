import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { auditChainKeyConfigured } from "@/lib/audit/chain-hash"
import { runChainerFor } from "@/lib/audit/chainer"

/**
 * The AuditLog chainer (lib/audit/chainer.ts). Scheduled once a minute and runs a
 * pass every 5 seconds for most of it, so a committed audit row is linked within
 * seconds. Every replica may run it: a chain is worked under an advisory lock and
 * a second runner skips the chains the first holds. 503 without AUDIT_CHAIN_KEY: an
 * unkeyed chain would prove nothing, so none is written.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  if (!auditChainKeyConfigured()) {
    console.error("[cron/audit-chainer] AUDIT_CHAIN_KEY is not configured; no audit row is being chained")
    return NextResponse.json({ ok: false, error: "AUDIT_CHAIN_KEY is not configured" }, { status: 503 })
  }
  const result = await runChainerFor(50_000, 5_000)
  return NextResponse.json({ ok: true, runAt: new Date().toISOString(), ...result })
}
