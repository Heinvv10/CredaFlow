/**
 * Accepts ONE break the verifier reports at a link (audit_chain_accept_break), so verification
 * continues past it: a link lost to a restore, a redaction made wrongly. It walks the chain, finds the
 * break at <seq> of <kind>, and signs exactly what it saw (the audit row, the link's hash and, for a
 * content mismatch, the hash the row recomputes to) with AUDIT_CHAIN_KEY; the verifier checks that
 * signature, so editing the row again afterwards is a new break. The database writes its own
 * AUDIT_CHAIN_BREAK_ACCEPTED row. Operator role only; the break stays visible as `accepted`.
 *
 *   AUDIT_CHAIN_KEY=<key> DATABASE_URL=<operator role> npm run audit:accept-break -- <chainKey or ""> <seq> <kind> "<reason>" <operator name>
 *   kind: the break kind the verifier reported (seq_gap, row_hash_mismatch, row_missing, ...)
 */
import { PrismaClient } from "@prisma/client"
import { repairHmac } from "@/lib/audit/chain-hash"
import { verifyAuditChains } from "@/lib/audit/chain-verify"

async function main(): Promise<number> {
  const [chainKey, seqText, kind, reason, operator] = process.argv.slice(2)
  const seq = Number(seqText)
  if (chainKey === undefined || !Number.isInteger(seq) || seq < 0 || !kind || !reason || !operator) {
    process.stderr.write('usage: audit-accept-break <chainKey or ""> <seq> <kind> "<reason>" <operator>\n')
    return 2
  }
  const db = new PrismaClient()
  try {
    const result = await verifyAuditChains(db, { chainKey, mode: "full" })
    const found = result.breaks.find((b) => b.chainSeq === seq && b.kind === kind)
    if (!found) {
      process.stderr.write(`no unaccepted ${kind} break at seq ${seq} of chain "${chainKey}"; the verifier reports: ${result.breaks.map((b) => `${b.kind}@${b.chainSeq}`).join(", ") || "none"}\n`)
      return 1
    }
    const subject = { chainKey, seq, kind, auditLogId: found.auditLogId ?? "", linkRowHash: found.linkRowHash, observedHash: found.observedHash }
    await db.$executeRaw`SELECT public.audit_chain_accept_break(${chainKey}, ${seq}::int, ${kind}, ${subject.auditLogId}, ${subject.linkRowHash}, ${subject.observedHash}, ${reason}, ${operator}, ${repairHmac(subject, reason, operator)})`
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
