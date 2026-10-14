/**
 * Metadata-only review of corpus statements that raised balance or revision
 * signals (goal 2026-10-14 §3.6). Prints, per document ID: bank, read method,
 * producer and creator, appended revisions, creation and modification dates,
 * the balance difference in cents, how many rows break the running balance,
 * and how many of those breaks look like a row printed without posting
 * (balance unmoved by exactly the row's amount — a reader-side quirk, as with
 * FNB's collection attempts). Never prints a name, account number, amount
 * other than the difference, or any transaction text.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/corpus \
 *     npx tsx scripts/statement-tamper-review.ts <id> [<id> …]
 */
import { readFileSync } from "node:fs"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { checkBalance } from "@/lib/statement-analysis/balance-check"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"

async function main() {
  const dir = process.env.STATEMENT_CORPUS_DIR
  const ids = process.argv.slice(2)
  if (!dir || ids.length === 0) throw new Error("usage: STATEMENT_CORPUS_DIR=… statement-tamper-review.ts <id> …")
  const files = new Map(loadCorpus(dir).map((f) => [f.id, f]))
  process.stdout.write("| id | bank | method | producer | creator | revisions | created | modified | diff (c) | breaks | unposted-like |\n|---|---|---|---|---|---|---|---|---|---|---|\n")
  for (const id of ids) {
    const f = files.get(id)
    if (!f) {
      process.stdout.write(`| ${id} | not in corpus |\n`)
      continue
    }
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (!r) {
      process.stdout.write(`| ${id} | — | needs vision reader (not run here) |\n`)
      continue
    }
    const a = r.authenticity
    const tx = r.read?.transactions ?? []
    const breaks = r.read ? checkBalance(r.read).breaks : []
    const unpostedLike = breaks.filter((i) => {
      const prev = i > 0 ? tx[i - 1].balanceCents : r.read!.openingBalanceCents
      return prev !== null && tx[i].balanceCents === prev
    }).length
    const cell = (v: string | null) => (v ?? "—").replace(/\|/g, "/").slice(0, 40)
    process.stdout.write(`| ${id} | ${r.bank ?? "—"} | ${r.method} | ${cell(a.producer)} | ${cell(a.creator)} | ${a.incrementalUpdates} | ${cell(a.createdAt)} | ${cell(a.modifiedAt)} | ${r.balanceDiffCents ?? "—"} | ${breaks.length} | ${unpostedLike} |\n`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "failed")
  process.exit(1)
})
