import { NextRequest, NextResponse } from "next/server"
import { processEscalations } from "@/lib/collections/escalation"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sweepStatus } from "@/lib/collections/tenant-sweep"

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await processEscalations()

  // `errors` is a rule that threw while advancing a loan's DPD-based
  // escalation (soft-reminder note, auto Section 129 at 20 days, DEFAULTED
  // status flip at 60, legal flag at 90 — see lib/collections/escalation.ts).
  // Previously this had NO counter at all: a rule failing on every run for a
  // given loan left that loan permanently un-escalated and invisible, and the
  // systemd wrapper calls this with `curl -fsS`, which only fails the unit on
  // HTTP >= 400 and never parses this body.
  //
  // A tenant whose whole run threw is counted in `errors` and named in
  // `details`; it turns the response 503 only when every tenant failed
  // (sweepStatus).
  const { status, partial } = sweepStatus({
    tenants: result.tenants,
    failedTenants: result.failedTenants,
    otherErrors: result.errors - result.failedTenants,
  })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status })
}
