/**
 * The local model's labels for the categoriser's accuracy gate and coverage
 * (goal 2026-10-15 §3 A3), asked exactly as production asks
 * (lib/statement-analysis/model-labels.ts): for each key the rules leave
 * UNCATEGORISED, the masked key alone, same prompt, temperature 0. Writes
 * `key \t category` outside the repository; prints counts only.
 *
 *   VLM_API_URL=… VLM_MODEL=… npx tsx scripts/statement-categoriser-model-labels.ts keys <keys.tsv> <out.tsv> [--all]
 *   STATEMENT_CORPUS_DIR=… VLM_API_URL=… VLM_MODEL=… npx tsx scripts/statement-categoriser-model-labels.ts corpus <out.tsv>
 *
 * keys: the merchant keys in column 1 of a merchant-keys file. --all labels
 *   every key, not only the rules' UNCATEGORISED ones, to measure the model on
 *   its own; dev keys only (held-out keys are scored only as production runs).
 * corpus: every distinct rule-UNCATEGORISED debit key of the corpus TEXT reads,
 *   for `statement-categoriser-corpus.ts coverage --model-labels`.
 *
 * The model is shared: this refuses to run 08:00–17:00 SAST on weekdays. Check
 * no demo bake is running before starting it.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { loadCorpus } from "@/lib/statement-analysis/accuracy/run"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { categorise } from "@/lib/statement-analysis/categorise"
import { labelKey, labelKeys } from "@/lib/statement-analysis/model-labels"
import { VlmUnavailableError } from "@/lib/statement-analysis/vlm-reader"
import { refuseHostedForRealData } from "@/lib/vlm-extract"
import { isDevKey } from "./statement-merchant-keys"

class ScriptError extends Error {}

/** 08:00–17:00 SAST (UTC+2, no daylight saving), Monday to Friday. */
export function inBusinessHours(now: Date): boolean {
  const sast = new Date(now.getTime() + 2 * 3_600_000)
  const day = sast.getUTCDay()
  const hour = sast.getUTCHours()
  return day >= 1 && day <= 5 && hour >= 8 && hour < 17
}

const debitKey = (description: string) => categorise({ date: "2026-01-01", description, amountCents: -1, balanceCents: null, page: 1 }, { clientName: null }).category

async function corpusKeys(dir: string): Promise<string[]> {
  const keys = new Set<string>()
  for (const f of loadCorpus(dir).filter((f) => f.mimeType === "application/pdf")) {
    const r = await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm: false }).catch((err: unknown) => {
      if (err instanceof VlmUnavailableError) return null
      throw err
    })
    if (!r?.read || r.method !== "TEXT") continue
    const ctx = { clientName: r.read.accountHolderName }
    for (const t of r.read.transactions) {
      if (t.amountCents < 0 && !t.nonPosting && categorise(t, ctx).category === "UNCATEGORISED") keys.add(labelKey(t.description))
    }
  }
  return [...keys].filter(Boolean)
}

async function main() {
  const [mode, a, b] = process.argv.slice(2)
  refuseHostedForRealData()
  if (inBusinessHours(new Date())) throw new ScriptError("the shared model: run outside 08:00–17:00 SAST on weekdays")
  const out = mode === "keys" ? b : a
  if (!out || (mode !== "keys" && mode !== "corpus")) throw new ScriptError("usage: statement-categoriser-model-labels.ts keys <keys.tsv> <out.tsv> [--all] | corpus <out.tsv>")
  // Corpus-derived labels never enter the repository.
  const inside = relative(realpathSync(process.cwd()), realpathSync(dirname(resolve(out))))
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new ScriptError("write the labels outside the repository")
  let keys: string[]
  if (mode === "keys") {
    const all = readFileSync(a, "utf8").trim().split("\n").map((l) => l.split("\t")[0]).filter(Boolean)
    if (process.argv.includes("--all")) {
      if (!all.every(isDevKey)) throw new ScriptError("--all is for the dev set only")
      keys = all
    } else {
      keys = all.filter((k) => debitKey(k) === "UNCATEGORISED")
    }
  } else {
    if (!process.env.STATEMENT_CORPUS_DIR) throw new ScriptError("set STATEMENT_CORPUS_DIR")
    keys = await corpusKeys(process.env.STATEMENT_CORPUS_DIR)
  }
  const { labels, version } = await labelKeys(keys)
  writeFileSync(out, Object.entries(labels).map(([k, c]) => `${k}\t${c}`).join("\n") + "\n", { mode: 0o600 })
  const counts = new Map<string, number>()
  for (const c of Object.values(labels)) counts.set(c, (counts.get(c) ?? 0) + 1)
  process.stdout.write(`${version}: ${keys.length} keys labelled\n`)
  for (const [c, n] of [...counts].sort((x, y) => y[1] - x[1])) process.stdout.write(`  ${c}: ${n}\n`)
}

if (require.main === module) {
  main().catch((err) => {
    // The message of our own refusals only; any other error is named, never quoted (it can echo corpus text).
    console.error(`failed: ${err instanceof ScriptError || err instanceof VlmUnavailableError ? err.message : err instanceof Error ? err.name : "unknown"}`)
    process.exit(1)
  })
}
