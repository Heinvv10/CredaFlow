/**
 * The boundary rows ABSA Transaction History and Discovery cannot check by
 * arithmetic, through the real pipeline: pdf-lib builds two consecutive
 * statements of one account, poppler reads them, the manual-review check
 * raises the boundary flags and notes which statement each agrees with.
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

/** Each boundary flag as "doc CODE neighbour", the neighbour being the statement it agrees with or "-". */
const boundary = (statements: StatementFacts[]) =>
  manualReview(facts({ statements })).filter((c) => BOUNDARY.includes(c.code))
    .map((c) => `${c.key.split(":")[0]} ${c.code} ${(c.evidence.chainedWith as { documentId?: string } | undefined)?.documentId ?? "-"}`).sort()

describe.each<[SynthBank, string[], string[]]>([
  // ABSA prints its closing ("Balance Carried Forward"), so only first rows are ever in question.
  ["ABSA", ["apr FIRST_ROW_UNVERIFIED -", "jul FIRST_ROW_UNVERIFIED apr"], ["apr FIRST_ROW_UNVERIFIED -", "jul FIRST_ROW_UNVERIFIED -"]],
  ["DISCOVERY",
    ["apr FIRST_ROW_UNVERIFIED -", "apr LAST_ROW_UNVERIFIED jul", "jul FIRST_ROW_UNVERIFIED apr", "jul LAST_ROW_UNVERIFIED -"],
    ["apr FIRST_ROW_UNVERIFIED -", "apr LAST_ROW_UNVERIFIED -", "jul FIRST_ROW_UNVERIFIED -", "jul LAST_ROW_UNVERIFIED -"]],
])("%s consecutive statements", (bank, chained, unchained) => {
  it("still raise the boundary they share, noting the statement each side agrees with", async () => {
    const [apr, jul] = consecutive(bank)
    const a = await read("apr", bank, apr)
    const b = await read("jul", bank, jul)
    expect([a.balanceCheck, b.balanceCheck]).toEqual(["PASS", "PASS"])
    expect(boundary([a, b])).toEqual(chained)
  })

  it("note no agreement when the later one opens elsewhere", async () => {
    const [apr, jul] = consecutive(bank)
    expect(boundary([await read("apr", bank, apr), await read("jul", bank, { ...jul, openingCents: jul.openingCents + 100 })])).toEqual(unchained)
  })

  it("note no agreement for an amount edited on the later statement's first row, which its own arithmetic cannot see", async () => {
    const [apr, jul] = consecutive(bank)
    // The salary-sized edit a forger makes: the printed amount changes, the balances stay true.
    const doctored = await read("jul", bank, jul, { misprint: { index: 0, amountCents: jul.transactions[0].amountCents + 500_000 } })
    expect(doctored.balanceCheck).toBe("PASS")
    expect(boundary([await read("apr", bank, apr), doctored])).toEqual(unchained)
  })
})

describe("a forged chain: an inflated first row plus a fabricated previous statement in the other ABSA layout", () => {
  it("keeps FIRST_ROW_UNVERIFIED raised and notes no agreement", async () => {
    const [, jul] = consecutive("ABSA")
    const inflated = jul.transactions[0].amountCents + 500_000
    // Transaction History derives its opening from the first row: inflating the row lowers it.
    const forgedOpening = jul.openingCents + jul.transactions[0].amountCents - inflated
    const forged = await read("jul", "ABSA", jul, { misprint: { index: 0, amountCents: inflated } })
    expect(forged.read!.openingBalanceCents).toBe(forgedOpening)
    // An eStatement prints its opening, so nothing of its own is unverified; it closes on the forged opening.
    const april = syntheticStatement({ bank: "ABSA_ESTATEMENT", start: "2026-04-01" })
    const fabricated = { ...april, openingCents: april.openingCents + forgedOpening - balances(april).at(-1)! }
    const prior = await read("apr", "ABSA_ESTATEMENT", fabricated)
    expect([prior.balanceCheck, prior.read!.closingBalanceCents, prior.read!.accountNumberLast4]).toEqual(["PASS", forgedOpening, forged.read!.accountNumberLast4])
    expect(boundary([prior, forged])).toEqual(["jul FIRST_ROW_UNVERIFIED -"])
  })
})
