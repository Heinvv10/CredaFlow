import { NextResponse } from "next/server"
import { probeDatabase } from "@/lib/ops/health-checks"

/**
 * Readiness probe: the database answers. Storage and cron freshness stay on
 * /api/health, which does a write/read/delete round trip and is too heavy to
 * poll every few seconds. Public body only: a status, no detail.
 */
export async function GET() {
  const database = await probeDatabase()
  const ready = database.state === "ok"
  return NextResponse.json(
    { status: ready ? "ready" : "not_ready" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  )
}
