import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { attachDatabaseCollectors } from "@/lib/observability/metrics-collectors"
import { getMetrics } from "@/lib/observability/metrics"

/** `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time. */
function bearerMatches(req: Request, token: string): boolean {
  const header = req.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return false
  const given = Buffer.from(header.slice("Bearer ".length))
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * Prometheus scrape endpoint. Off (404) until METRICS_TOKEN is set; then
 * bearer-only, whatever the host. The series are operational, not client data,
 * but route names and error rates are not for the public.
 */
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN?.trim()
  if (!token) return new NextResponse(null, { status: 404 })
  if (!bearerMatches(req, token)) {
    return new NextResponse("unauthorized\n", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } })
  }
  attachDatabaseCollectors()
  const { registry } = getMetrics()
  return new NextResponse(await registry.metrics(), {
    headers: { "Content-Type": registry.contentType, "Cache-Control": "no-store" },
  })
}
