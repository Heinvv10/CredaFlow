/**
 * Platform-operator bootstrap: the one SUPER_ADMIN the bake's operator steps
 * sign in as (breadth/setup.ts enableOperatorModules → /api/admin/tenants).
 *
 * The product has no route that creates a SUPER_ADMIN. Settings → Users
 * refuses to assign a role above the caller's, the base seed creates only an
 * ADMIN and a credit officer, and the operator API needs a SUPER_ADMIN to
 * begin with. A platform operator is not a lender's staff member, so this is
 * provisioned beside the seed instead: the one place the simulator writes a
 * row rather than driving the API.
 *
 *   scripts/demo/sim/seed-faked.sh scripts/demo/sim/provision-operator.ts \
 *     | npx tsx scripts/demo/sim/provision-operator.ts --store
 *
 * Without --store (in the seed's faketime container, sim/seed-faked.sh) it
 * upserts the operator for the "acme" tenant exactly as prisma/seed.ts
 * upsertStaff does: bcrypt cost 12, a TOTP secret from lib/totp kept across
 * reruns, totpEnabled. A rerun updates the same row (new password), so there is
 * never a second operator; another SUPER_ADMIN in the tenant is refused. It
 * prints the credentials as one JSON line on stdout. With --store (on the host:
 * the container mounts the worktree read-only) it reads that line and records
 * it in .sim-breadth-staff.json (breadth/staff.ts).
 *
 * No AuditLog row: upsertStaff writes none for the staff the seed creates, and
 * this mirrors it. A bootstrap has no signed-in user to attribute a row to.
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

import { generateTotpSecret } from "../../../lib/totp"
import { STAFF, storeStaffCredentials, type StoredStaff } from "../breadth/staff"
import { log } from "./env"

const TENANT_SLUG = "acme"

async function provision(): Promise<StoredStaff> {
  if (process.env.NODE_ENV === "production") throw new Error("refused: NODE_ENV=production")
  const spec = STAFF.operator
  const prisma = new PrismaClient()
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG }, select: { id: true } })
    if (!tenant) throw new Error(`no ${TENANT_SLUG} tenant; run the base seed first`)
    const existing = await prisma.user.findUnique({ where: { email: spec.email }, select: { tenantId: true, role: true, totpSecret: true } })
    if (existing && (existing.tenantId !== tenant.id || existing.role !== spec.role)) {
      throw new Error(`refused: ${spec.email} exists as ${existing.role} in tenant ${existing.tenantId ?? "none"}`)
    }
    const others = await prisma.user.count({ where: { tenantId: tenant.id, role: spec.role, email: { not: spec.email } } })
    if (others > 0) throw new Error(`refused: the ${TENANT_SLUG} tenant already has another ${spec.role}`)

    const password = randomBytes(18).toString("base64url")
    const totpSecret = existing?.totpSecret ?? generateTotpSecret()
    const fields = { tenantId: tenant.id, active: true, totpSecret, totpEnabled: true, password: await bcrypt.hash(password, 12) }
    const user = await prisma.user.upsert({
      where: { email: spec.email },
      update: fields,
      create: { ...fields, email: spec.email, name: spec.name, role: spec.role },
      select: { id: true },
    })
    return { userId: user.id, email: spec.email, password, totpSecret }
  } finally {
    await prisma.$disconnect()
  }
}

async function store(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n")
  const creds = JSON.parse(lines[lines.length - 1] ?? "null") as StoredStaff | null
  if (!creds || creds.email !== STAFF.operator.email || !creds.userId || !creds.password || !creds.totpSecret) {
    throw new Error("provision-operator --store: stdin does not hold the operator's credentials")
  }
  storeStaffCredentials(creds)
  log(`platform operator ${creds.email} provisioned`)
}

const run = process.argv.includes("--store")
  ? store()
  : provision().then((creds) => { process.stdout.write(`${JSON.stringify(creds)}\n`) })
run.catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
