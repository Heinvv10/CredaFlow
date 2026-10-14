import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { runLeaseInvoiceBatch } from "@/lib/asset-finance/lease-invoice-batch"

/**
 * Lease tax-invoice cron (slice 3, C4): issues the tax invoice of every lease
 * rental that has fallen due (lib/asset-finance/lease-invoice-batch.ts).
 * Gated by CRON_SECRET. Idempotent, so it is safe to run any number of times
 * a day. Answers 503 with the counts when any rental failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const run = await runLeaseInvoiceBatch(prisma, sastCalendarDate(new Date()))
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
