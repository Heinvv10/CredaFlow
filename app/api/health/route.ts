import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { isOperatorRole } from "@/lib/operator/roles"

const noStoreHeaders = { "Cache-Control": "no-store" }

const RLS_INACTIVE =
  "The application's database role is a superuser or BYPASSRLS: row-level security is not enforced (docs/ARCHITECTURE.md, RLS activation checklist)"

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

/** The RLS warning, for an operator session only: a public probe learns nothing of the setup. */
let warnedThisProcess = false
async function operatorWarnings(rlsBypassed: boolean): Promise<{ warnings?: string[] }> {
  if (!rlsBypassed) return {}
  // Every probe would repeat it; once per process is enough for the logs.
  if (!warnedThisProcess) console.warn(`[health] ${RLS_INACTIVE}`)
  warnedThisProcess = true
  try {
    // Loaded only when there is something to say, so the probe stays cheap.
    const { auth } = await import("@/lib/auth")
    const session = await auth()
    return isOperatorRole(session?.user?.role) ? { warnings: [RLS_INACTIVE] } : {}
  } catch (err) {
    // The probe reports the database, not the session: never fail it on auth.
    console.error("[health] could not read the session for the RLS warning:", err)
    return {}
  }
}

export async function GET() {
  try {
    // Doubles as the database check.
    const [role] = await prisma.$queryRaw<{ su?: boolean; bypass?: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    const warnings = await operatorWarnings(role?.su === true || role?.bypass === true)
    return NextResponse.json(
      { status: "ok", ...deployMetadata(), ...warnings },
      { headers: noStoreHeaders },
    )
  } catch {
    return NextResponse.json(
      { status: "error", ...deployMetadata() },
      { status: 503, headers: noStoreHeaders },
    )
  }
}
