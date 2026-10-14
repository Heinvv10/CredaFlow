import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { encryptionState, probeCron, probeDatabase, probeStorage } from "@/lib/ops/health-checks"

const noStoreHeaders = { "Cache-Control": "no-store" }

function deployMetadata() {
  return {
    mode: process.env.APP_MODE || "all",
    commit:
      process.env.GIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
      "unknown",
    builtAt: process.env.BUILD_TIME || process.env.BUILT_AT || "unknown",
    checkedAt: new Date().toISOString(),
  }
}

/** Per-job detail (names, timestamps) is for the operator only: x-cron-secret. */
function wantsDetail(req: Request | undefined): boolean {
  const secret = process.env.CRON_SECRET
  const given = req?.headers.get("x-cron-secret")
  if (!secret || !given) return false
  const a = Buffer.from(secret), b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * `status` is "ok" (200) when the database answers and storage round-trips a
 * file, else "error" (503); deploy.sh waits for "ok". `warnings` names what
 * is degraded but does not fail the check: stale cron jobs, storage
 * encryption off.
 */
export async function GET(req?: Request) {
  const [database, storage] = await Promise.all([probeDatabase(), probeStorage()])
  const cron = database.state === "ok" ? await probeCron() : { state: "error" as const, jobs: [] }
  const encryption = encryptionState()
  const ok = database.state === "ok" && storage === "ok"
  const warnings = [
    ...(cron.state === "stale" ? ["cron_stale"] : []),
    ...(cron.state === "error" ? ["cron_unknown"] : []),
    ...(encryption === "off" ? ["storage_encryption_off"] : []),
  ]
  const body = {
    status: ok ? "ok" : "error",
    ...deployMetadata(),
    checks: { database: database.state, storage, storageEncryption: encryption, cron: cron.state },
    warnings,
    ...(wantsDetail(req) ? { detail: { databaseLatencyMs: database.latencyMs, cronJobs: cron.jobs } } : {}),
  }
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: noStoreHeaders })
}
