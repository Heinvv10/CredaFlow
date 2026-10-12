/**
 * The platform operator's bootstrap (sim/provision-operator.ts is the command).
 *
 * The product has no route that creates a SUPER_ADMIN. Settings → Users
 * refuses to assign a role above the caller's, the base seed creates only an
 * ADMIN and a credit officer, and the operator API needs a SUPER_ADMIN to
 * begin with. A platform operator is not a lender's staff member, so it is
 * provisioned beside the seed instead: the one place the simulator writes a
 * row rather than driving the API.
 *
 * It upserts the operator for the "acme" tenant exactly as prisma/seed.ts
 * upsertStaff does: bcrypt cost 12, a TOTP secret from lib/totp kept across
 * reruns, totpEnabled. A rerun updates the same row (new password), so there is
 * never a second operator; another SUPER_ADMIN in the tenant is refused.
 *
 * It writes only to the demo-sim database: DATABASE_URL must name the sim's
 * db service, and the database must carry the marker sim/fresh-stack.sh
 * writes when it creates it (a database comment; pg_dump without --create
 * leaves it out of every snapshot, so a restored live database never has it).
 *
 * No AuditLog row: upsertStaff writes none for the staff the seed creates, and
 * this mirrors it. A bootstrap has no signed-in user to attribute a row to.
 */
import { randomBytes } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

import { generateTotpSecret } from "../../../lib/totp"
import { STAFF, type StoredStaff } from "../breadth/staff"
import { SIM_DB_SERVICE_ADDRESS } from "./env"

export const OPERATOR_TENANT_SLUG = "acme"
/** The demo-sim database's comment (SIM_DB_MARKER in scripts/demo/lib.sh). */
export const SIM_DATABASE_MARKER = "credaflow-demo-sim"

export type OperatorDb = Pick<PrismaClient, "$queryRaw" | "tenant" | "user">

/** null when this process may write the operator; otherwise why not. */
export function targetRefusal(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === "production") return "refused: NODE_ENV=production"
  let address: string
  try {
    const url = new URL(env.DATABASE_URL ?? "")
    address = `${url.hostname}:${url.port || "5432"}`
  } catch {
    return "refused: DATABASE_URL is not a URL"
  }
  return address === SIM_DB_SERVICE_ADDRESS
    ? null
    : `refused: DATABASE_URL points at ${address}, not the sim db service ${SIM_DB_SERVICE_ADDRESS}`
}

export async function provisionOperator(db: OperatorDb): Promise<StoredStaff> {
  const [database] = await db.$queryRaw<Array<{ marker: string | null }>>`
    SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`
  if (database?.marker !== SIM_DATABASE_MARKER) {
    throw new Error(`refused: not the demo-sim database (its comment is not "${SIM_DATABASE_MARKER}"; sim/fresh-stack.sh writes it)`)
  }
  const spec = STAFF.operator
  const tenant = await db.tenant.findUnique({ where: { slug: OPERATOR_TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`no ${OPERATOR_TENANT_SLUG} tenant; run the base seed first`)
  const existing = await db.user.findUnique({ where: { email: spec.email }, select: { tenantId: true, role: true, totpSecret: true } })
  if (existing && (existing.tenantId !== tenant.id || existing.role !== spec.role)) {
    throw new Error(`refused: ${spec.email} exists as ${existing.role} in tenant ${existing.tenantId ?? "none"}`)
  }
  const others = await db.user.count({ where: { tenantId: tenant.id, role: spec.role, email: { not: spec.email } } })
  if (others > 0) throw new Error(`refused: the ${OPERATOR_TENANT_SLUG} tenant already has another ${spec.role}`)

  const password = randomBytes(18).toString("base64url")
  const totpSecret = existing?.totpSecret ?? generateTotpSecret()
  const fields = { tenantId: tenant.id, active: true, totpSecret, totpEnabled: true, password: await bcrypt.hash(password, 12) }
  const user = await db.user.upsert({
    where: { email: spec.email },
    update: fields,
    create: { ...fields, email: spec.email, name: spec.name, role: spec.role },
    select: { id: true },
  })
  return { userId: user.id, email: spec.email, password, totpSecret }
}

/** The operator's credentials from the provisioning output (its last line). */
export function parseOperatorCredentials(text: string): StoredStaff {
  const lines = text.trim().split("\n")
  let parsed: unknown = null
  try {
    parsed = JSON.parse(lines[lines.length - 1] ?? "")
  } catch {
    parsed = null
  }
  const creds = parsed as Partial<StoredStaff> | null
  if (
    !creds || typeof creds !== "object" || creds.email !== STAFF.operator.email ||
    typeof creds.userId !== "string" || !creds.userId ||
    typeof creds.password !== "string" || !creds.password ||
    typeof creds.totpSecret !== "string" || !creds.totpSecret
  ) {
    throw new Error("provision-operator --store: stdin does not hold the operator's credentials")
  }
  return { userId: creds.userId, email: creds.email, password: creds.password, totpSecret: creds.totpSecret }
}
