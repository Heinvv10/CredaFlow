/**
 * Goal §8.2: every doctored synthetic statement raises a DOCUMENT_AUTHENTICITY
 * flag, and the untouched originals raise none. Real PDFs through the real
 * pipeline: pdf-lib builds them, poppler reads them.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { analyseStatement, type StatementAnalysisResult } from "@/lib/statement-analysis/analyse"
import { syntheticStatement } from "@/lib/statement-analysis/fixtures/dataset"
import { incrementalAmountEdit, resaveWithProducer } from "@/lib/statement-analysis/fixtures/doctor"
import { buildCapitecStatement, buildFnbStatement, type BuildOptions } from "@/lib/statement-analysis/fixtures/synthetic"
import { documentAuthenticity } from "./document-authenticity"
import { facts } from "./facts.test-helpers"
import type { StatementFacts } from "./types"

type Bank = "CAPITEC" | "FNB"
const statementFor = (bank: Bank) => syntheticStatement({ bank, start: "2026-07-01" })
const build = (bank: Bank, opts: BuildOptions = {}) =>
  bank === "CAPITEC" ? buildCapitecStatement(statementFor(bank), opts) : buildFnbStatement(statementFor(bank), opts)
/** The grocery amount as each bank prints it on the first row. */
const groceries = { CAPITEC: ["-845.50", "-945.50"], FNB: ["845.50", "945.50"] } as const

function asFacts(r: StatementAnalysisResult): StatementFacts {
  return {
    documentId: "doc-fx", analysisId: "an-fx", state: r.status, method: r.method, bank: r.bank,
    read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity,
  }
}

async function authenticityCodes(pdf: Uint8Array): Promise<string[]> {
  const r = await analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
  return documentAuthenticity(facts({ statements: [asFacts(r)] })).map((c) => c.code).sort()
}

const doctored: Array<[string, (bank: Bank) => Promise<Uint8Array>, string[]]> = [
  ["an amount edited via an incremental update",
    async (bank) => incrementalAmountEdit(await build(bank), groceries[bank][0], groceries[bank][1]),
    // The second code proves poppler renders the appended revision: the edit took.
    ["INCREMENTAL_UPDATE", "RUNNING_BALANCE_BREAK"]],
  ["a statement re-saved through a different producer",
    async (bank) => resaveWithProducer(await build(bank), "Microsoft® Word for Microsoft 365"), ["PRODUCER_UNEXPECTED"]],
  ["a transaction changed without fixing the balance",
    (bank) => build(bank, { misprint: { index: 0, amountCents: -94_550 } }), ["RUNNING_BALANCE_BREAK"]],
  ["a ModDate later than its CreationDate",
    (bank) => build(bank, { createdAt: new Date("2026-10-01T08:00:00Z"), modifiedAt: new Date("2026-10-03T10:00:00Z") }), ["MODIFIED_AFTER_CREATION"]],
]

describe.each(["CAPITEC", "FNB"] as const)("%s doctored fixtures", (bank) => {
  it("the untouched original raises no authenticity flag", async () => {
    expect(await authenticityCodes(await build(bank))).toEqual([])
  })

  it.each(doctored)("%s raises a DOCUMENT_AUTHENTICITY flag", async (_label, make, expected) => {
    expect(await authenticityCodes(await make(bank))).toEqual(expect.arrayContaining(expected))
  })
})

describe("the committed fixture PDFs (scripts/generate-statement-fixtures.ts)", () => {
  const dir = join(__dirname, "..", "statement-analysis", "fixtures", "pdf")
  const read = (file: string) => authenticityCodes(readFileSync(join(dir, file)))

  it.each(["capitec", "fnb"])("%s-genuine.pdf raises no authenticity flag", async (bank) => {
    expect(await read(`${bank}-genuine.pdf`)).toEqual([])
  })

  it.each([
    ["incremental-edit", "INCREMENTAL_UPDATE"],
    ["resaved-word", "PRODUCER_UNEXPECTED"],
    ["balance-not-fixed", "RUNNING_BALANCE_BREAK"],
    ["modified-after-creation", "MODIFIED_AFTER_CREATION"],
  ])("every bank's %s.pdf raises %s", async (variant, code) => {
    for (const bank of ["capitec", "fnb"]) expect(await read(`${bank}-${variant}.pdf`)).toContain(code)
  })
})
