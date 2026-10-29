/**
 * Accepts a break the verifier reported at one link (audit_chain_accept_break), so verification
 * continues past it: a link lost to a restore, a redaction made wrongly. The acceptance is signed
 * here (HMAC under AUDIT_CHAIN_KEY over chain, seq, kind, reason and operator), which the verifier
 * checks, and the database writes its own AUDIT_CHAIN_BREAK_ACCEPTED row. Operator role only; the
 * break stays visible in the report as `accepted`.
 *
 *   AUDIT_CHAIN_KEY=<key> DATABASE_URL=<operator role> npm run audit:accept-break -- <chainKey or ""> <seq> <kind> "<reason>" <operator name>
 *   kind: the break kind the verifier reported (seq_gap, row_hash_mismatch, row_missing, ...)
 */
import { PrismaClient } from "@prisma/client"
import { repairHmac } from "@/lib/audit/chain-hash"

async function main(): Promise<number> {
  const [chainKey, seqText, kind, reason, operator] = process.argv.slice(2)
  const seq = Number(seqText)
  if (chainKey === undefined || !Number.isInteger(seq) || seq < 0 || !kind || !reason || !operator) {
    process.stderr.write('usage: audit-accept-break <chainKey or ""> <seq> <kind> "<reason>" <operator>\n')
    return 2
  }
  const db = new PrismaClient()
  try {
    await db.$executeRaw`SELECT public.audit_chain_accept_break(${chainKey}, ${seq}::int, ${kind}, ${reason}, ${operator}, ${repairHmac(chainKey, seq, kind, reason, operator)})`
    process.stdout.write(`accepted ${kind} at seq ${seq} of chain "${chainKey}"\n`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`audit-accept-break failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
