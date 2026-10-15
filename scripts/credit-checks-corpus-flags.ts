/**
 * The credit checks' flags over the off-repo statement corpus, as counts and
 * one digest, to prove a change leaves the existing checks' output alone
 * (goal 2026-10-14 §4: the v1 flag set must be identical before and after).
 * Run it on both trees and compare the output. Prints counts only.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/corpus npx tsx scripts/credit-checks-corpus-flags.ts
 *
 * Each statement is checked alone (no client, payslip, debts or application
 * date to compare it with), the way accuracy/run.ts checks authenticity.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { runChecks } from "@/lib/credit-checks/run-checks"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"

async function main() {
  const dir = process.env.STATEMENT_CORPUS_DIR
  if (!dir) throw new Error("set STATEMENT_CORPUS_DIR")
  const prints: string[] = []
  const counts = new Map<string, number>()
  for (const f of loadCorpus(dir)) {
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (!r) continue
    const flags = runChecks({
      applicationId: f.id, applicationDate: "2026-10-14", clientName: "", monthlyIncomeCents: null, payslip: null, debts: [],
      deletedStatementIds: [], mismatchedPayslipIds: [], unreadPayslipIds: [], deletedPayslipIds: [], extractedPayslipIds: [], priorOpenFlagApplications: [],
      statements: [{ documentId: f.id, analysisId: f.id, contentSha256: f.id, state: r.status, method: r.method, bank: r.bank, read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity }],
    })
    for (const c of flags) {
      prints.push(c.fingerprint)
      counts.set(`${c.check}/${c.code}`, (counts.get(`${c.check}/${c.code}`) ?? 0) + 1)
    }
  }
  for (const [k, n] of [...counts].sort()) process.stdout.write(`${k}: ${n}\n`)
  process.stdout.write(`flags: ${prints.length}; fingerprint digest: ${createHash("sha256").update(prints.sort().join("\n")).digest("hex").slice(0, 16)}\n`)
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.name : "unknown"}`)
  process.exit(1)
})
