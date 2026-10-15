/**
 * The boundary rows ABSA Transaction History and Discovery cannot check by
 * arithmetic, through the real pipeline: pdf-lib builds two consecutive
 * statements of one account, poppler reads them, the manual-review check
 * decides which boundary rows still go to a person.
 */
import { describe, expect, it } from "vitest"
import { analyseStatement } from "@/lib/statement-analysis/analyse"
import { syntheticStatement, type SynthBank } from "@/lib/statement-analysis/fixtures/dataset"
import { balances, type BuildOptions, type SynthStatement } from "@/lib/statement-analysis/fixtures/synthetic"
import { buildStatement } from "@/lib/statement-analysis/fixtures/synthetic-banks"
import { facts } from "./facts.test-helpers"
import { manualReview } from "./manual-review"
import type { StatementFacts } from "./types"

const BOUNDARY = ["FIRST_ROW_UNVERIFIED", "LAST_ROW_UNVERIFIED"]

/** April–June, then July–September opening where June closed. */
function consecutive(bank: SynthBank): [SynthStatement, SynthStatement] {
  const first = syntheticStatement({ bank, start: "2026-04-01" })
  const closing = balances(first).at(-1)!
  return [first, { ...syntheticStatement({ bank, start: "2026-07-01" }), openingCents: closing }]
}

async function read(id: string, bank: SynthBank, s: SynthStatement, opts: BuildOptions = {}): Promise<StatementFacts> {
  const r = await analyseStatement(Buffer.from(await buildStatement(bank, s, opts)), "application/pdf", { allowVlm: false })
  return { documentId: id, analysisId: `an-${id}`, contentSha256: `sha-${id}`, state: r.status, method: r.method, bank: r.bank, read: r.read, balanceCheck: r.balanceCheck, authenticity: r.authenticity }
}

const boundary = (statements: StatementFacts[]) =>
  manualReview(facts({ statements })).filter((c) => BOUNDARY.includes(c.code)).map((c) => `${c.key.split(":")[0]} ${c.code}`).sort()

describe.each<[SynthBank, string[], string[]]>([
  // ABSA prints its closing ("Balance Carried Forward"), so only first rows are ever in question.
  ["ABSA", ["apr FIRST_ROW_UNVERIFIED"], ["apr FIRST_ROW_UNVERIFIED", "jul FIRST_ROW_UNVERIFIED"]],
  ["DISCOVERY", ["apr FIRST_ROW_UNVERIFIED", "jul LAST_ROW_UNVERIFIED"],
    ["apr FIRST_ROW_UNVERIFIED", "apr LAST_ROW_UNVERIFIED", "jul FIRST_ROW_UNVERIFIED", "jul LAST_ROW_UNVERIFIED"]],
])("%s consecutive statements", (bank, chained, unchained) => {
  it("verify the boundary they share, and only that one", async () => {
    const [apr, jul] = consecutive(bank)
    const a = await read("apr", bank, apr)
    const b = await read("jul", bank, jul)
    expect([a.balanceCheck, b.balanceCheck]).toEqual(["PASS", "PASS"])
    expect(boundary([a, b])).toEqual(chained)
  })

  it("leave both sides flagged when the later one opens elsewhere", async () => {
    const [apr, jul] = consecutive(bank)
    expect(boundary([await read("apr", bank, apr), await read("jul", bank, { ...jul, openingCents: jul.openingCents + 100 })])).toEqual(unchained)
  })

  it("still catch an amount edited on the later statement's first row, which its own arithmetic cannot", async () => {
    const [apr, jul] = consecutive(bank)
    // The salary-sized edit a forger makes: the printed amount changes, the balances stay true.
    const doctored = await read("jul", bank, jul, { misprint: { index: 0, amountCents: jul.transactions[0].amountCents + 500_000 } })
    expect(doctored.balanceCheck).toBe("PASS")
    expect(boundary([await read("apr", bank, apr), doctored])).toEqual(unchained)
  })
})
