import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"
import { encryptionState, probeCron, probeDatabase, probeStorage, recentOutboxFailures } from "@/lib/ops/health-checks"
import { prisma } from "@/lib/prisma"
import { isOperatorRole } from "@/lib/operator/roles"
import { warnAuditSetupOnce } from "@/lib/audit/deployment-check"
import { envCredentialsWarning, warnEnvCredentialsOnce } from "@/lib/integrations/tenant-credentials"

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

/** The checks, warnings and per-job detail are for the operator only: x-cron-secret… */
function hasCronSecret(req: Request | undefined): boolean {
  const secret = process.env.CRON_SECRET
  const given = req?.headers.get("x-cron-secret")
  if (!secret || !given) return false
  const a = Buffer.from(secret), b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * …or a signed-in operator user (lib/operator/). Only a request carrying a
 * cookie is looked at, so probes (deploy.sh, monitors) never load the session.
 * A session that cannot be read is no operator: the probe never fails on auth.
 */
async function hasOperatorSession(req: Request | undefined): Promise<boolean> {
  if (!req?.headers.get("cookie")) return false
  try {
    const { auth } = await import("@/lib/auth")
    return isOperatorRole((await auth())?.user?.role)
  } catch (err) {
    console.error("[health] could not read the session:", err)
    return false
  }
}

const RLS_INACTIVE =
  "The application's database role is a superuser or BYPASSRLS: row-level security is not enforced (docs/ARCHITECTURE.md, RLS activation checklist)"

/**
 * Platform setup warnings: the runtime role bypasses row-level security, or
 * environment credentials are set but owned by no tenant. Each is logged once
 * per process, so the logs say it even when no operator asks.
 */
let rlsWarningLogged = false
async function setupWarnings(): Promise<string[]> {
  const warnings: string[] = []
  const [role] = await prisma.$queryRaw<{ su?: boolean; bypass?: boolean }[]>`
    SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
  if (role?.su === true || role?.bypass === true) {
    if (!rlsWarningLogged) console.warn(`[health] ${RLS_INACTIVE}`)
    rlsWarningLogged = true
    warnings.push("db_role_bypasses_rls")
  }
  warnings.push(...(await warnAuditSetupOnce()))
  const envCredentials = await envCredentialsWarning()
  if (envCredentials) {
    warnEnvCredentialsOnce(envCredentials)
    warnings.push("env_credentials_unowned")
  }
  return warnings
}
let setupChecked = false

/**
 * `status` is "ok" (200) when the database answers and storage round-trips a
 * file, else "error" (503); deploy.sh waits for "ok". Anyone sees `status` and
 * the deploy marker deploy.sh compares (mode, commit, build time: as before
 * this route grew its checks). Which check failed, `warnings` (stale cron
 * jobs, storage encryption off, the platform setup warnings) and per-job
 * detail are only answered to a caller with the x-cron-secret header or an
 * operator session. Probe errors are logged, never returned.
 */
export async function GET(req?: Request) {
  const [database, storage] = await Promise.all([probeDatabase(), probeStorage()])
  const ok = database.state === "ok" && storage === "ok"
  const publicBody = { status: ok ? "ok" : "error", ...deployMetadata() }
  const operator = hasCronSecret(req) || await hasOperatorSession(req)
  // The setup checks run for an operator, and once per process for the logs.
  const setup = database.state === "ok" && (operator || !setupChecked) ? await setupWarnings().catch((err: unknown) => {
    console.error("[health] setup check failed", err)
    return [] as string[]
  }) : []
  setupChecked = true
  if (!operator) return NextResponse.json(publicBody, { status: ok ? 200 : 503, headers: noStoreHeaders })

  const cron = database.state === "ok" ? await probeCron() : { state: "error" as const, jobs: [] }
  const encryption = encryptionState()
  const lostEvents = database.state === "ok" ? await recentOutboxFailures() : null
  const warnings = [
    ...(cron.state === "stale" ? ["cron_stale"] : []),
    ...(cron.state === "error" ? ["cron_unknown"] : []),
    ...(encryption === "off" ? ["storage_encryption_off"] : []),
    ...(lostEvents !== null && lostEvents > 0 ? ["webhook_outbox_failures"] : []),
    ...setup,
  ]
  const body = {
    ...publicBody,
    checks: { database: database.state, storage, storageEncryption: encryption, cron: cron.state },
    warnings,
    detail: { databaseLatencyMs: database.latencyMs, cronJobs: cron.jobs, webhookOutboxFailures24h: lostEvents },
  }
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: noStoreHeaders })
}
