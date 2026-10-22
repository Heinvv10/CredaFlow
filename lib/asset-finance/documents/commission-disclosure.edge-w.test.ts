// Edge tester W: names the author may not have tried, on all nine render paths.
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { CASES, introducerRow, printed } from "./commission-disclosure.test-helpers"
import { DealDocumentError } from "./deal-document-data"
import { texts } from "./nca/nca-wording.test-helpers"
import { dealerNameProblem, MAX_DEALER_NAME } from "./wording/dealer-name"

const OK = ["Société Générale Motors", "Müller & Söhne (Pty) Ltd", "O'Brien's Plant-Hire, Cape Town", "Ørsted Škoda Œuvre", "Café ñandú", "D’Arcy Motors", "A&B", "7-Eleven Trucks", "(Pty) Ltd Motors", "Z"]
const BAD = ["Şahin Motors", "Łódź Motors", "ﬁsh Motors", "Motors​", "Motors X", "Motors Ltd", "á Motors", "Motors😀", "Motors\ttab", "ＡＢＣ Motors", "Ω Motors"]

describe("edge-w dealerNameProblem", () => {
  it.each(OK)("accepts %s", (n) => expect(dealerNameProblem(n)).toBeNull())
  it.each(BAD)("refuses %j", (n) => expect(dealerNameProblem(n)).not.toBeNull())
  it("boundary 80 / 81", () => {
    expect(dealerNameProblem("A".repeat(MAX_DEALER_NAME))).toBeNull()
    expect(dealerNameProblem("A".repeat(MAX_DEALER_NAME + 1))).not.toBeNull()
  })
})

describe.each(CASES)("edge-w $name", ({ render, clause, heading }) => {
  it.each(OK)("prints %s exactly", async (name) => {
    const lines = await texts(await render({ name, kind: "DEALER" }))
    expect(printed(lines)).toContain(`${heading ? `${heading} ` : ""}${introducerRow({ name, kind: "DEALER" })} ${clause}`)
    expect(printed(lines)).not.toContain("?")
  })

  it.each(BAD)("a name that is refused by the rule is refused by the renderer: %j", async (name) => {
    await expect(render({ name, kind: "DEALER" })).rejects.toThrow(DealDocumentError)
  })

  it.each([
    ["80 chars, no spaces", "W".repeat(80)],
    ["80 chars of words", "Wilhelmina Konstantinopoulos & Sons Heavy Plant Hire and Haulage (Pty) Ltd".padEnd(80, "x")],
    ["80 wide letters", "MW".repeat(40)],
  ])("a long valid name (%s) is printed in full, inside the page, page footers consistent", async (_l, name) => {
    const base = await render(null)
    const bytes = await render({ name, kind: "BROKER" })
    const lines = await texts(bytes)
    // Name may wrap across lines: rejoined without separator when it is one token.
    expect(printed(lines).replace(/\s+/g, "")).toContain(name.replace(/\s+/g, ""))
    const pages = (await pdfPageContents(bytes)).length
    const basePages = (await pdfPageContents(base)).length
    expect(pages - basePages).toBeLessThanOrEqual(1)
    const footers = lines.filter((l) => /^Page \d+ of \d+$/.test(l))
    expect(footers.length).toBe(pages)
    footers.forEach((f, i) => expect(f).toBe(`Page ${i + 1} of ${pages}`))
    // The paragraph is not lost to a clipped line.
    expect(printed(lines)).toContain(clause)
  })
})
