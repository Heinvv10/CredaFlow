/**
 * Why a corpus statement fails the balance check, without showing its content.
 *
 *   STATEMENT_CORPUS_DIR=/home/hein/secure/ndzinga-corpus \
 *     npx tsx scripts/statement-read-diagnostics.ts NEDBANK [--failing]
 *
 * Per file of that bank: method, rows read, whether opening/closing were
 * found, the balance difference in cents, and each running-balance break as
 * (row index, page, gap in cents). For each break it prints the shape of the
 * rows around it: signs and digit counts of amount and balance only
 * (e.g. "-9999.99 / 999.99"). No description, name, account number or real
 * figure is printed. Pair with statement-layout-shapes.ts --id/--page.
 */
import { readFileSync } from "node:fs"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { checkBalance } from "@/lib/statement-analysis/balance-check"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"

const bank = process.argv[2]
const failingOnly = process.argv.includes("--failing")
/** Generic banking words that may print unmasked in a description's shape; every other word is masked. */
const BANKING_WORDS = new Set(("fee fees charge charges debit credit order orders reversal reversed reverse unpaid attempt declined " +
  "returned return pending notific notification sms bank transaction transfer payment purchase card cash withdrawal deposit " +
  "interest monthly admin service immediate digital ext to from acb debicheck insufficient funds stop refund adj adjustment " +
  "eft pos atm settlement nominated account statement int dr cr").split(" "))
const descShape = (d: string) => d.split(/\s+/).map((w) => (BANKING_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")) ? w : w.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9"))).join(" ")
const shape = (c: number | null) => (c === null ? "null" : `${c < 0 ? "-" : ""}${(Math.abs(c) / 100).toFixed(2).replace(/\d/g, "9")}`)

async function main() {
  const dir = process.env.STATEMENT_CORPUS_DIR
  if (!dir || !bank) throw new Error("usage: STATEMENT_CORPUS_DIR=… statement-read-diagnostics.ts <BANK> [--failing]")
  for (const f of loadCorpus(dir).filter((f) => f.mimeType === "application/pdf")) {
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (!r || r.bank !== bank) continue
    if (failingOnly && r.balanceCheck === "PASS") continue
    const tx = r.read?.transactions ?? []
    const check = r.read ? checkBalance(r.read) : null
    const out = [
      f.id, r.method, r.status, `producer=${(r.authenticity.producer ?? "-").slice(0, 24)}`, `rows=${tx.length}`,
      `pages=${new Set(tx.map((t) => t.page)).size}`, `opening=${r.read?.openingBalanceCents != null}`,
      `closing=${r.read?.closingBalanceCents != null}`, `check=${r.balanceCheck}`, `diffShape=${shape(r.balanceDiffCents)}`,
      `holder=${r.read?.accountHolderName ? r.read.accountHolderName.replace(/[A-Za-z]/g, "a").replace(/\d/g, "9") : "null"}`,
      `last4=${r.read?.accountNumberLast4 ? "yes" : "null"}`, `period=${r.read?.periodStart ? "yes" : "null"}`,
      `nullBalances=${tx.filter((t) => t.balanceCents === null).length}`,
    ]
    process.stdout.write(`${out.join(" ")}\n`)
    for (const i of check?.breaks.slice(0, 5) ?? []) {
      const prev = i > 0 ? tx[i - 1].balanceCents : r.read!.openingBalanceCents
      const gap = prev === null || tx[i].balanceCents === null ? null : tx[i].balanceCents! - prev - tx[i].amountCents
      process.stdout.write(`  break row=${i} page=${tx[i].page} date=${tx[i].date.slice(5)} gapShape=${shape(gap)}`)
      for (let j = Math.max(0, i - 2); j <= Math.min(tx.length - 1, i + 1); j++) process.stdout.write(` | ${j}: ${shape(tx[j].amountCents)} / ${shape(tx[j].balanceCents)}`)
      // Relations only, no values: what kind of misread or bank quirk this is.
      const next = tx[i + 1]
      process.stdout.write(` || desc="${descShape(tx[i].description)}" balanceUnchanged=${tx[i].balanceCents === prev} gapIsAmount=${gap === -tx[i].amountCents}` +
        ` nextNegates=${next?.amountCents === -tx[i].amountCents} sameDateNext=${next?.date === tx[i].date}` +
        ` swapFixes=${!!next && prev !== null && next.balanceCents !== null && prev + next.amountCents === next.balanceCents}`)
      process.stdout.write("\n")
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "failed")
  process.exit(1)
})
