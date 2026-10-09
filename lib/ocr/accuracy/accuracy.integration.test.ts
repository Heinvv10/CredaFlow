/**
 * Scores the real extraction pipeline against a real VLM. See README.md.
 *
 *   VLM_ACCURACY_CORPUS=/secure/path VLM_API_URL=... VLM_MODEL=... \
 *     RUN_VLM_ACCURACY=1 npx vitest run lib/ocr/accuracy/
 *
 * Defaults to the committed synthetic corpus when VLM_ACCURACY_CORPUS is unset.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractDocumentData } from "@/lib/vlm-extract"
import { formatReport, loadManifest, scoreCase, type CaseOutcome } from "./run"

const RUN = process.env.RUN_VLM_ACCURACY === "1"
const suite = RUN ? describe : describe.skip
const corpusDir = process.env.VLM_ACCURACY_CORPUS ?? join(import.meta.dirname, "sample-corpus")

// An opt-in suite that skips silently is indistinguishable from one that passes,
// and this one exists precisely to stop us believing an unmeasured claim.
if (!RUN) {
  console.warn(
    "\n[accuracy] SKIPPED — extraction accuracy was NOT measured in this run.\n" +
    "[accuracy] RUN_VLM_ACCURACY=1 with VLM_API_URL/VLM_MODEL set to measure it.\n",
  )
}

suite("payslip extraction accuracy", () => {
  it("scores every case in the corpus and reports per field", async () => {
    const cases = loadManifest(corpusDir)
    expect(cases.length, `no cases found in ${corpusDir}`).toBeGreaterThan(0)

    const outcomes: CaseOutcome[] = []
    for (const testCase of cases) {
      const result = await extractDocumentData({
        fileBuffer: readFileSync(join(corpusDir, testCase.file)),
        mimeType: testCase.file.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
        docType: testCase.docType,
      })
      outcomes.push(scoreCase(testCase, result.data ?? null, result.error))
    }

    console.log(formatReport(outcomes))

    // Reading a year-to-date figure as this month's income is the failure that
    // over-lends. It is never an acceptable score, however good the rest looks.
    const traps = outcomes.flatMap((o) => o.fields.filter((f) => f.status === "trap"))
    expect(traps, `wrong-column reads: ${traps.map((t) => t.field).join(", ")}`).toEqual([])
  }, 120_000)
})
