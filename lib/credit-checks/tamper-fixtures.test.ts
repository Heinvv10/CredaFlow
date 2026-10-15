/**
 * Goal §8.2: every doctored synthetic statement raises a DOCUMENT_AUTHENTICITY
 * flag, and the untouched originals raise none. Real PDFs through the real
 * pipeline: pdf-lib builds them, poppler reads them.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { analyseStatement, type StatementAnalysisResult } from "@/lib/statement-analysis/analyse"
import { syntheticStatement, type SynthBank } from "@/lib/statement-analysis/fixtures/dataset"
import { incrementalAmountEdit, resaveWithProducer } from "@/lib/statement-analysis/fixtures/doctor"
import { type BuildOptions } from "@/lib/statement-analysis/fixtures/synthetic"
import { buildStatement, TAMPER_TARGET } from "@/lib/statement-analysis/fixtures/synthetic-banks"
import { documentAuthenticity } from "./document-authenticity"
import { facts } from "./facts.test-helpers"
import type { StatementFacts } from "./types"

type Bank = SynthBank
const BANKS: Bank[] = ["CAPITEC", "FNB", "NEDBANK", "ABSA", "ABSA_ESTATEMENT", "STANDARD_BANK", "DISCOVERY"]
const statementFor = (bank: Bank) => syntheticStatement({ bank, start: "2026-07-01" })
const build = (bank: Bank, opts: BuildOptions = {}) => buildStatement(bank, statementFor(bank), opts)
/** The row each bank's doctored variants edit, and its amount as printed before and after. */
const target = (bank: Bank) => TAMPER_TARGET[bank]

function asFacts(r: StatementAnalysisResult): StatementFacts {
  return {
    documentId: "doc-fx", analysisId: "an-fx", contentSha256: "sha-fx", state: r.status, method: r.method, bank: r.bank,
    read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity,
  }
}

async function authenticityCodes(pdf: Uint8Array): Promise<string[]> {
  const r = await analyseStatement(Buffer.from(pdf), "application/pdf", { allowVlm: false })
  return documentAuthenticity(facts({ statements: [asFacts(r)] })).map((c) => c.code).sort()
}

const doctored: Array<[string, (bank: Bank) => Promise<Uint8Array>, string[]]> = [
  ["an amount edited via an incremental update",
    async (bank) => incrementalAmountEdit(await build(bank), ...target(bank).printed),
    // The second code proves poppler renders the appended revision: the edit took.
    ["INCREMENTAL_UPDATE", "RUNNING_BALANCE_BREAK"]],
  ["a statement re-saved through a different producer",
    async (bank) => resaveWithProducer(await build(bank), "Microsoft® Word for Microsoft 365"), ["PRODUCER_UNEXPECTED"]],
  ["a transaction changed without fixing the balance",
    (bank) => build(bank, { misprint: { index: target(bank).row, amountCents: statementFor(bank).transactions[target(bank).row].amountCents - 10_000 } }),
    ["RUNNING_BALANCE_BREAK"]],
  ["a ModDate later than its CreationDate",
    (bank) => build(bank, { createdAt: new Date("2026-10-01T08:00:00Z"), modifiedAt: new Date("2026-10-03T10:00:00Z") }), ["MODIFIED_AFTER_CREATION"]],
]

/** Appends the trailer-only save Word's "hybrid-xref" writes: no object, no xref entry. */
function withWordHybridTail(original: Uint8Array): Uint8Array {
  const base = Buffer.from(original)
  const tail = base.subarray(base.lastIndexOf("trailer")).toString("latin1")
  const prev = /startxref\s+(\d+)/.exec(tail)![1]
  const size = /\/Size (\d+)/.exec(tail)![1]
  const root = /\/Root (\d+ \d+ R)/.exec(tail)![1]
  const info = /\/Info (\d+ \d+ R)/.exec(tail)![1]
  const xref = base.length + 2
  return Buffer.concat([base, Buffer.from(
    `\r\nxref\r\n0 0\r\ntrailer\r\n<</Size ${size}/Root ${root}/Info ${info}/ID[<0A1B2C><0A1B2C>] /Prev ${prev}>>\r\nstartxref\r\n${xref}\r\n%%EOF`, "latin1")])
}

describe.each(BANKS)("%s doctored fixtures", (bank) => {
  it("the untouched original raises no authenticity flag", async () => {
    expect(await authenticityCodes(await build(bank))).toEqual([])
  })

  it("the original with Word's trailer-only save appended raises no authenticity flag", async () => {
    expect(await authenticityCodes(withWordHybridTail(await build(bank)))).toEqual([])
  })

  it.each(doctored)("%s raises a DOCUMENT_AUTHENTICITY flag", async (_label, make, expected) => {
    expect(await authenticityCodes(await make(bank))).toEqual(expect.arrayContaining(expected))
  })
})

describe("the committed fixture PDFs (scripts/generate-statement-fixtures.ts)", () => {
  const dir = join(__dirname, "..", "statement-analysis", "fixtures", "pdf")
  const read = (file: string) => authenticityCodes(readFileSync(join(dir, file)))

  const names = BANKS.map((b) => b.toLowerCase().replace(/_/g, "-"))

  it.each(names)("%s-genuine.pdf raises no authenticity flag", async (bank) => {
    expect(await read(`${bank}-genuine.pdf`)).toEqual([])
  })

  it.each([
    ["incremental-edit", "INCREMENTAL_UPDATE"],
    ["resaved-word", "PRODUCER_UNEXPECTED"],
    ["balance-not-fixed", "RUNNING_BALANCE_BREAK"],
    ["modified-after-creation", "MODIFIED_AFTER_CREATION"],
  ])("every bank's %s.pdf raises %s", async (variant, code) => {
    for (const bank of names) expect(await read(`${bank}-${variant}.pdf`), bank).toContain(code)
  })
})
