/**
 * Runs the real statement pipeline over the off-repo corpus. See README.md.
 *
 *   STATEMENT_CORPUS_DIR=/secure/path/to/statements RUN_STATEMENT_ACCURACY=1 \
 *     [STATEMENT_ACCURACY_VLM=1 VLM_API_URL=... VLM_MODEL=...] \
 *     [STATEMENT_ACCURACY_REPORT=/path/report.md] \
 *     npx vitest run lib/statement-analysis/accuracy/
 *
 * Without STATEMENT_ACCURACY_VLM=1 the vision reader is not called and those
 * files are counted as SKIPPED: the model is shared, so corpus vision runs
 * happen only outside 08:00–17:00 SAST on weekdays.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { analyseStatement } from "../analyse"
import { VlmUnavailableError } from "../vlm-reader"
import { formatReport, loadCorpus, outcomeOf, textPassRate, type Outcome } from "./run"

const RUN = process.env.RUN_STATEMENT_ACCURACY === "1"
const suite = RUN ? describe : describe.skip
const corpusDir = process.env.STATEMENT_CORPUS_DIR ?? ""
const allowVlm = process.env.STATEMENT_ACCURACY_VLM === "1"

if (!RUN) {
  process.stderr.write("\n[statement-accuracy] SKIPPED — reader accuracy was NOT measured in this run.\n")
}

suite("statement reader accuracy (corpus)", () => {
  it("reads the corpus; bank-produced Capitec/FNB PDFs pass the balance check by text", async () => {
    const files = loadCorpus(corpusDir)
    expect(files.length, `no statements in ${corpusDir}`).toBeGreaterThan(0)

    const outcomes: Outcome[] = []
    for (const f of files) {
      try {
        outcomes.push(outcomeOf(f.id, await analyseStatement(readFileSync(f.path), f.mimeType, { allowVlm })))
      } catch (err) {
        if (!(err instanceof VlmUnavailableError)) throw err
        outcomes.push({ id: f.id, bank: null, method: "SKIPPED", status: "SKIPPED", balanceCheck: "NOT_APPLICABLE", bankProduced: false, authenticityCodes: [] })
      }
    }

    const report = formatReport(outcomes)
    process.stdout.write(`\n${report}\n`)
    if (process.env.STATEMENT_ACCURACY_REPORT) writeFileSync(process.env.STATEMENT_ACCURACY_REPORT, `${report}\n`)

    // Goal §8.1: ≥ 95% balance PASS by the text method.
    const own = textPassRate(outcomes, true)
    expect(own.pass / own.total).toBeGreaterThanOrEqual(0.95)
    // Goal §8.3: no genuine (bank-produced) statement reads as a balance break.
    const falseTamper = outcomes.filter((o) => o.bankProduced && o.method === "TEXT"
      && o.authenticityCodes.some((c) => c === "BALANCE_MISMATCH" || c === "RUNNING_BALANCE_BREAK"))
    expect(falseTamper.map((o) => o.id)).toEqual([])
  }, 1_800_000)
})
