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

/** The checks, warnings and per-job detail are for the operator only: x-cron-secret. */
function isOperator(req: Request | undefined): boolean {
  const secret = process.env.CRON_SECRET
  const given = req?.headers.get("x-cron-secret")
  if (!secret || !given) return false
  const a = Buffer.from(secret), b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * `status` is "ok" (200) when the database answers and storage round-trips a
 * file, else "error" (503); deploy.sh waits for "ok". Anyone sees `status` and
 * the deploy marker deploy.sh compares (mode, commit, build time: as before
 * this route grew its checks). Which check failed, `warnings` (stale cron
 * jobs, storage encryption off) and per-job detail are only answered to a
 * caller with the x-cron-secret header. Probe errors are logged, never returned.
 */
export async function GET(req?: Request) {
  const [database, storage] = await Promise.all([probeDatabase(), probeStorage()])
  const ok = database.state === "ok" && storage === "ok"
  const publicBody = { status: ok ? "ok" : "error", ...deployMetadata() }
  if (!isOperator(req)) return NextResponse.json(publicBody, { status: ok ? 200 : 503, headers: noStoreHeaders })

  const cron = database.state === "ok" ? await probeCron() : { state: "error" as const, jobs: [] }
  const encryption = encryptionState()
  const warnings = [
    ...(cron.state === "stale" ? ["cron_stale"] : []),
    ...(cron.state === "error" ? ["cron_unknown"] : []),
    ...(encryption === "off" ? ["storage_encryption_off"] : []),
  ]
  const body = {
    ...publicBody,
    checks: { database: database.state, storage, storageEncryption: encryption, cron: cron.state },
    warnings,
    detail: { databaseLatencyMs: database.latencyMs, cronJobs: cron.jobs },
  }
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: noStoreHeaders })
}
