/**
 * Platform-operator bootstrap: the one SUPER_ADMIN the bake's operator steps
 * sign in as (breadth/setup.ts enableOperatorModules → /api/admin/tenants).
 * The product has no route that creates one; sim/operator.ts says why this
 * exists, what it writes and what it refuses.
 *
 *   scripts/demo/sim/seed-faked.sh scripts/demo/sim/provision-operator.ts \
 *     | npx tsx scripts/demo/sim/provision-operator.ts --store       (fresh-stack.sh)
 *   scripts/demo/sim/seed-faked.sh scripts/demo/sim/provision-operator.ts --retire
 *   npx tsx scripts/demo/sim/provision-operator.ts --forget <snapshot>/.sim-breadth-staff.json   (bake.sh)
 *
 * In the seed's faketime container (sim/seed-faked.sh), with no flag it
 * provisions the operator in the demo-sim database and prints the credentials
 * as one JSON line on stdout; --retire deactivates it before the snapshot is
 * dumped. On the host (the container mounts the worktree read-only), --store
 * reads that line and records it in .sim-breadth-staff.json
 * (breadth/staff.ts), and --forget drops the operator from a copy of that file.
 */
import { readFileSync, writeFileSync } from "node:fs"

import { PrismaClient } from "@prisma/client"

import { storeStaffCredentials } from "../breadth/staff"
import { log } from "./env"
import { parseOperatorCredentials, provisionOperator, retireOperator, targetRefusal, withoutOperator } from "./operator"

async function inSimDb(work: (prisma: PrismaClient) => Promise<void>): Promise<void> {
  const refusal = targetRefusal(process.env)
  if (refusal) throw new Error(refusal)
  const prisma = new PrismaClient()
  try {
    await work(prisma)
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

function forget(file: string | undefined): void {
  if (!file) throw new Error("usage: provision-operator.ts --forget <file>")
  writeFileSync(file, JSON.stringify(withoutOperator(JSON.parse(readFileSync(file, "utf8"))), null, 2), { mode: 0o600 })
  log(`platform operator dropped from ${file}`)
}

const [mode, arg] = process.argv.slice(2)
const run = mode === "--store" ? store()
  : mode === "--forget" ? Promise.resolve().then(() => forget(arg))
  : mode === "--retire" ? inSimDb(async (prisma) => { await retireOperator(prisma); log("platform operator retired") })
  : mode === undefined ? inSimDb(async (prisma) => { process.stdout.write(`${JSON.stringify(await provisionOperator(prisma))}\n`) })
  : Promise.reject(new Error(`unknown mode ${mode}`))
run.catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
