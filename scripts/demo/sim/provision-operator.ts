/**
 * Platform-operator bootstrap: the one SUPER_ADMIN the bake's operator steps
 * sign in as (breadth/setup.ts enableOperatorModules → /api/admin/tenants).
 * The product has no route that creates one; sim/operator.ts says why this
 * exists, what it writes and what it refuses.
 *
 *   scripts/demo/sim/seed-faked.sh scripts/demo/sim/provision-operator.ts \
 *     | npx tsx scripts/demo/sim/provision-operator.ts --store
 *
 * Without --store (in the seed's faketime container, sim/seed-faked.sh) it
 * provisions the operator in the demo-sim database and prints the credentials
 * as one JSON line on stdout. With --store (on the host: the container mounts
 * the worktree read-only) it reads that line and records it in
 * .sim-breadth-staff.json (breadth/staff.ts).
 */
import { PrismaClient } from "@prisma/client"

import { storeStaffCredentials } from "../breadth/staff"
import { log } from "./env"
import { parseOperatorCredentials, provisionOperator, targetRefusal } from "./operator"

async function provision(): Promise<void> {
  const refusal = targetRefusal(process.env)
  if (refusal) throw new Error(refusal)
  const prisma = new PrismaClient()
  try {
    process.stdout.write(`${JSON.stringify(await provisionOperator(prisma))}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

async function store(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const creds = parseOperatorCredentials(Buffer.concat(chunks).toString("utf8"))
  storeStaffCredentials(creds)
  log(`platform operator ${creds.email} provisioned`)
}

;(process.argv.includes("--store") ? store() : provision()).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
