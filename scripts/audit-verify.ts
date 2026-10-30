/**
 * Walks the AuditLog hash chains of the database in DATABASE_URL (needs AUDIT_CHAIN_KEY and
 * the worker's database access) and prints every break, and every break an operator accepted. Exit 0 when every chain holds, 1 on a
 * break, 2 on bad arguments or an error. Read-only.
 *
 *   npm run audit:verify                 # every chain, in full from the genesis
 *   npm run audit:verify -- --incremental  # from each chain's latest checkpoint
 *   npm run audit:verify -- <tenantId>   # one lender
 *   npm run audit:verify -- --platform   # rows with no tenant
 *   npm run audit:verify -- --json
 */
import { PrismaClient } from "@prisma/client"
import { verifyAuditChains } from "../lib/audit/chain-verify"

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const json = args.includes("--json")
  const incremental = args.includes("--incremental")
  const rest = args.filter((a) => a !== "--json" && a !== "--incremental")
  if (rest.length > 1 || rest.some((a) => a.startsWith("--") && a !== "--platform")) {
    process.stderr.write("usage: audit-verify [<tenantId> | --platform] [--json]\n")
    return 2
  }
  const chainKey = rest[0] === "--platform" ? "" : rest[0]
  const db = new PrismaClient()
  try {
    const result = await verifyAuditChains(db, { mode: incremental ? "incremental" : "full", ...(chainKey === undefined ? {} : { chainKey }) })
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else if (result.ok) {
      process.stdout.write(`OK: ${result.chains} chain(s), ${result.rowsChecked} links verified (${result.mode}), ${result.pendingUnchained} awaiting the chainer, ${result.accepted.length} accepted break(s)\n`)
    } else {
      for (const b of result.accepted) {
        process.stdout.write(`ACCEPTED chain "${b.chainKey || "(platform)"}": ${b.kind} at seq ${b.chainSeq ?? "-"}\n`)
      }
      for (const b of result.breaks) {
        process.stdout.write(`BROKEN chain "${b.chainKey || "(platform)"}": ${b.kind} at seq ${b.chainSeq ?? "-"} (row ${b.auditLogId ?? "-"}): ${b.detail}\n`)
      }
    }
    return result.ok ? 0 : 1
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`audit-verify failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
