/**
 * The categoriser over the off-repo statement corpus (goal 2026-10-14 §6).
 * Prints counts only.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/corpus npx tsx scripts/statement-categoriser-corpus.ts coverage [--model-labels <model.tsv>]
 *   STATEMENT_CORPUS_DIR=… MERCHANT_OUT_DIR=… VLM_API_URL=… VLM_MODEL=… \
 *     npx tsx scripts/statement-categoriser-corpus.ts longtail
 *
 * coverage: the share of debit value (and rows) the categoriser puts in a
 *   category other than UNCATEGORISED, and the value per category; with
 *   --model-labels (statement-categoriser-model-labels.ts corpus), after the
 *   model's labels as in production.
 * longtail: the debits of LONGTAIL_STATEMENTS statements whose key is not in
 *   the merchant list (mostly person-to-person payments) are labelled blind by
 *   the local model at VLM_API_URL — the only model corpus text may reach — and
 *   compared with the categoriser. Informative only: two machines agreeing is
 *   not accuracy. The shared model: run outside 08:00–17:00 SAST on weekdays.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { categorise, LIVING_CATEGORIES, type Category } from "@/lib/statement-analysis/categorise"
import { OTHER_CATEGORIES } from "@/lib/statement-analysis/categories"
import type { StatementRead } from "@/lib/statement-analysis/types"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { refuseHostedForRealData } from "@/lib/vlm-extract"
import { gateClass, readModelLabels } from "./statement-categoriser-accuracy"
import { maskKey } from "./statement-merchant-keys"

const LONGTAIL_STATEMENTS = 10
const BATCH = 40
const ALL: readonly string[] = [...LIVING_CATEGORIES, ...OTHER_CATEGORIES]

async function textReads(dir: string): Promise<Array<{ id: string; read: StatementRead }>> {
  const out: Array<{ id: string; read: StatementRead }> = []
  for (const f of loadCorpus(dir).filter((f) => f.mimeType === "application/pdf")) {
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (r?.read && r.method === "TEXT") out.push({ id: f.id, read: r.read })
  }
  return out
}

const debits = (read: StatementRead) => read.transactions.filter((t) => t.amountCents < 0 && !t.nonPosting)

function coverage(reads: Array<{ read: StatementRead }>, modelLabels: Record<string, string> | null) {
  const value = new Map<Category, number>()
  const rows = new Map<Category, number>()
  for (const { read } of reads) {
    for (const t of debits(read)) {
      const c = categorise(t, { clientName: read.accountHolderName, modelLabels }).category
      value.set(c, (value.get(c) ?? 0) - t.amountCents)
      rows.set(c, (rows.get(c) ?? 0) + 1)
    }
  }
  const total = [...value.values()].reduce((a, b) => a + b, 0)
  const totalRows = [...rows.values()].reduce((a, b) => a + b, 0)
  const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`
  process.stdout.write(`statements: ${reads.length}, debit rows: ${totalRows}\n`)
  process.stdout.write(`categorised (not UNCATEGORISED): ${pct(total - (value.get("UNCATEGORISED") ?? 0), total)} of debit value, ` +
    `${pct(totalRows - (rows.get("UNCATEGORISED") ?? 0), totalRows)} of debit rows\n`)
  for (const [c, v] of [...value].sort((a, b) => b[1] - a[1])) process.stdout.write(`  ${c}: ${pct(v, total)} of value, ${rows.get(c)} rows\n`)
}

async function labelWithModel(descriptions: string[]): Promise<string[]> {
  const url = `${process.env.VLM_API_URL!.replace(/\/$/, "")}/v1/chat/completions`
  const prompt = `Categorise each South African bank statement DEBIT description (money out) into exactly one of: ${ALL.join(", ")}. ` +
    "Living categories are the client's own spending; a payment to a person, a generic transfer or anything unclear is UNCATEGORISED. " +
    `Answer with a JSON array of ${descriptions.length} category strings, in order, nothing else.\n` +
    descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.VLM_MODEL, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  })
  const invalid = descriptions.map(() => "INVALID")
  if (!res.ok) return invalid
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = body.choices?.[0]?.message?.content ?? "[]"
  // Never let a parse error's message (which quotes the reply, and so corpus text) reach the output.
  try {
    const parsed: unknown = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1))
    return Array.isArray(parsed) && parsed.length === descriptions.length ? parsed.map(String) : invalid
  } catch {
    return invalid
  }
}

async function longtail(reads: Array<{ id: string; read: StatementRead }>, outDir: string) {
  const merchants = new Set(readFileSync(join(outDir, "merchant-keys.tsv"), "utf8").split("\n").map((l) => l.split("\t")[0]))
  const sample = [...reads].sort((a, b) => createHash("sha256").update(a.id).digest("hex").localeCompare(createHash("sha256").update(b.id).digest("hex")))
    .slice(0, LONGTAIL_STATEMENTS)
  const rows = sample.flatMap(({ read }) => debits(read).filter((t) => !merchants.has(maskKey(t.description)))
    .map((t) => ({ description: t.description, predicted: categorise(t, { clientName: read.accountHolderName }).category })))
  let agree = 0
  let gateAgree = 0
  let invalid = 0
  const byPair = new Map<string, number>()
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const labels = await labelWithModel(batch.map((r) => r.description))
    batch.forEach((r, j) => {
      const label = labels[j]
      if (!ALL.includes(label)) return void invalid++
      if (label === r.predicted) agree++
      if (gateClass(label as Category) === gateClass(r.predicted)) gateAgree++
      const pair = `${gateClass(label as Category)} → ${gateClass(r.predicted)}`
      byPair.set(pair, (byPair.get(pair) ?? 0) + 1)
    })
  }
  const valid = rows.length - invalid
  process.stdout.write(`long tail: ${LONGTAIL_STATEMENTS} statements, ${rows.length} debit rows outside the merchant list, ${invalid} unlabelled by the model\n`)
  process.stdout.write(`exact agreement: ${agree}/${valid}; gate-class agreement: ${gateAgree}/${valid} (informative only)\n`)
  for (const [k, n] of [...byPair].sort((a, b) => b[1] - a[1])) process.stdout.write(`  model → categoriser ${k}: ${n}\n`)
}

async function main() {
  refuseHostedForRealData()
  const dir = process.env.STATEMENT_CORPUS_DIR
  const mode = process.argv[2]
  if (!dir || (mode !== "coverage" && mode !== "longtail")) throw new Error("usage: STATEMENT_CORPUS_DIR=… statement-categoriser-corpus.ts coverage|longtail")
  const reads = await textReads(dir)
  const modelAt = process.argv.indexOf("--model-labels")
  if (mode === "coverage") return coverage(reads, modelAt > 0 ? readModelLabels(process.argv[modelAt + 1]) : null)
  if (!process.env.MERCHANT_OUT_DIR || !process.env.VLM_API_URL || !process.env.VLM_MODEL) throw new Error("longtail needs MERCHANT_OUT_DIR, VLM_API_URL, VLM_MODEL")
  await longtail(reads, process.env.MERCHANT_OUT_DIR)
}

main().catch((err) => {
  console.error(`failed: ${err instanceof Error ? err.name : "unknown"}`)
  process.exit(1)
})
