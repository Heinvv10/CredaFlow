/**
 * Writes the synthetic statement fixtures: a genuine Capitec-like and FNB-like
 * statement, and the four doctored variants of each (lib/statement-analysis/
 * fixtures/doctor.ts). Every value is invented.
 *
 *   npx tsx scripts/generate-statement-fixtures.ts [--start YYYY-MM-01] [--out DIR]
 *
 * Defaults: three months from 2026-07-01, into lib/statement-analysis/fixtures/pdf.
 * Pass a recent --start to get a statement that is not stale against an
 * application made today (browser acceptance).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { incrementalAmountEdit, resaveWithProducer } from "@/lib/statement-analysis/fixtures/doctor"
import { buildCapitecStatement, buildFnbStatement, type BuildOptions } from "@/lib/statement-analysis/fixtures/synthetic"

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const start = arg("--start", "2026-07-01")
const out = arg("--out", join(__dirname, "..", "lib", "statement-analysis", "fixtures", "pdf"))

async function main() {
  mkdirSync(out, { recursive: true })
  for (const bank of ["CAPITEC", "FNB"] as const) {
    const scenario = { bank, start, undisclosedLoan: true, gambling: true, paydayLender: true, returnedDebit: true }
    const build = (opts: BuildOptions = {}) =>
      bank === "CAPITEC" ? buildCapitecStatement(syntheticStatement(scenario), opts) : buildFnbStatement(syntheticStatement(scenario), opts)
    const name = bank.toLowerCase()
    const genuine = await build()
    const [from, to] = bank === "CAPITEC" ? ["-845.50", "-945.50"] : ["845.50", "945.50"]
    const files: Record<string, Uint8Array> = {
      [`${name}-genuine.pdf`]: genuine,
      [`${name}-incremental-edit.pdf`]: await incrementalAmountEdit(genuine, from, to),
      [`${name}-resaved-word.pdf`]: await resaveWithProducer(genuine, "Microsoft® Word for Microsoft 365"),
      [`${name}-balance-not-fixed.pdf`]: await build({ misprint: { index: 0, amountCents: -94_550 } }),
      [`${name}-modified-after-creation.pdf`]: await build({ modifiedAt: new Date("2026-10-03T10:00:00Z") }),
    }
    for (const [file, bytes] of Object.entries(files)) {
      writeFileSync(join(out, file), bytes)
      process.stdout.write(`wrote ${join(out, file)}\n`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
