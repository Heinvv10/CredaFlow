import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { renderInstalmentSaleAgreement } from "./agreement-pdf"
import { renderResolution } from "./resolution-pdf"
import { renderSuretyship } from "./suretyship-pdf"
import { renderDealDocument } from "./render"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "./pdf-layout"
import { DealDocumentError } from "./deal-document-data"
import { syntheticDealDocumentData } from "./synthetic-deal.fixture"
import { instalmentSaleClauses } from "./wording/instalment-sale"
import { resolutionClauses } from "./wording/resolution"
import { suretyshipClauses } from "./wording/suretyship"

// CP1252 0x80-0x9F (Node's TextDecoder may decode that range as Latin-1).
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) =>
  [...Buffer.from(hex, "hex")].map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join("")

/** Every string drawn on each page, WinAnsi decoded, rotated text included. */
async function pageTexts(bytes: Buffer): Promise<string[][]> {
  return (await pdfPageContents(bytes)).map((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
}
/** The rotation matrix the watermark is drawn with (anything but the identity). */
const ROTATED_TM = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) [\d.-]+ [\d.-]+ Tm\s*<([0-9A-Fa-f]+)> Tj/g
/** One line of text, as the wrapped PDF lines rejoin it. */
const normalise = (text: string) => text.replace(/\s+/g, " ").trim()
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const draft = syntheticDealDocumentData()
const approved = syntheticDealDocumentData({ legalWordingApproved: true })

describe("deal document renderers", () => {
  it("prints the DRAFT watermark diagonally on every page while the legal wording is not approved", async () => {
    for (const bytes of [
      await renderInstalmentSaleAgreement(draft),
      await renderResolution(draft),
      await renderSuretyship(draft, "client-surety"),
    ]) {
      const pages = await pageTexts(bytes)
      expect(pages.length).toBeGreaterThan(0)
      for (const page of pages) expect(page).toContain(DRAFT_WATERMARK)
      const contents = await pdfPageContents(bytes)
      for (const content of contents) {
        const rotated = [...content.matchAll(ROTATED_TM)].filter((m) => m[2] !== "0")
        expect(rotated).toHaveLength(1)
      }
    }
  })

  it("omits the watermark on every document once the legal wording is approved, and the bytes differ", async () => {
    const renders: ((d: typeof draft) => Promise<Buffer>)[] = [
      renderInstalmentSaleAgreement,
      renderResolution,
      (d) => renderSuretyship(d, "client-surety"),
    ]
    for (const render of renders) {
      const off = await render(draft)
      const on = await render(approved)
      for (const page of await pageTexts(on)) expect(page).not.toContain(DRAFT_WATERMARK)
      expect(sha(on)).not.toBe(sha(off))
    }
  })

  it("prints every clause heading with its drafted wording and no placeholder", async () => {
    const surety = draft.sureties.find((s) => s.clientId === "client-surety")
    if (!surety) throw new Error("fixture surety missing")
    const documents: [Buffer, string, { heading: string; text: string }[]][] = [
      [await renderInstalmentSaleAgreement(draft), "7", instalmentSaleClauses(draft)],
      [await renderResolution(draft), "4", resolutionClauses(draft)],
      [await renderSuretyship(draft, "client-surety"), "5", suretyshipClauses(draft, surety)],
    ]
    for (const [bytes, section, clauses] of documents) {
      const lines = (await pageTexts(bytes)).flat()
      const text = normalise(lines.join(" "))
      expect(lines).not.toContain(PLACEHOLDER_CLAUSE)
      expect(text).not.toContain("Placeholder clause")
      expect(clauses.length).toBeGreaterThanOrEqual(3)
      clauses.forEach((c, i) => {
        expect(c.text.trim().length).toBeGreaterThan(80)
        expect(lines).toContain(`${section}.${i + 1} ${c.heading}`)
        for (const paragraph of c.text.split(/\n{2,}/)) expect(text).toContain(normalise(paragraph).slice(0, 60))
      })
    }
  })

  it("words the agreement's clauses with the deal's own rate, dates and arrears terms", async () => {
    const text = normalise((await pageTexts(await renderInstalmentSaleAgreement(draft))).flat().join(" "))
    expect(text).toContain("it is Prime plus 1.00% a year")
    expect(text).toContain("the reference rate is 10.75% (effective 29 May 2026), so the Contract Rate is 11.75% a year")
    expect(text).toContain("schedule start date shown in section 5, 31 December 2026")
    expect(text).toContain("at the Contract Rate in force from time to time plus 2.00% a year")
    expect(text).toContain("a collection fee of R 450.00")
    expect(text).toContain("includes the balloon of R 300,000.00")
    expect(text).toContain("its registered office at 1 Test Street, Testville, 0001; the Purchaser, 2 Test Road, Testburg, Gauteng, 0002")

    const fixed = syntheticDealDocumentData({
      pricing: { ...draft.pricing, rateBasis: "FIXED", rateMargin: null, fixedRate: "0.1175", reference: null, arrearsMarginRate: null, collectionFeeCents: 0 },
    })
    const fixedText = normalise((await pageTexts(await renderInstalmentSaleAgreement(fixed))).flat().join(" "))
    expect(fixedText).toContain("The Contract Rate is 11.75% a year (nominal), fixed for the whole term")
    expect(fixedText).toContain("No default interest is charged on overdue amounts")
    expect(fixedText).toContain("No collection fee is charged")
    expect(fixedText).not.toContain("Prime")
  })

  it("names the surety, principal debtor and agreement, and drops s90-unlawful terms for an NCA principal debt", async () => {
    const commercial = normalise((await pageTexts(await renderSuretyship(draft, "client-surety"))).flat().join(" "))
    expect(commercial).toContain(`TEST Surety ("the Surety") is bound to the creditor`)
    expect(commercial).toContain("TEST Earthmoving (Pty) Ltd, for the due and punctual payment")
    expect(commercial).toContain("the agreement reference AF-TEST-0001")
    expect(commercial).toContain("is prima facie proof of its contents")
    expect(commercial).toContain("section 45 of the Magistrates' Courts Act")
    expect(commercial).toContain("section 15(2)(h) of the Matrimonial Property Act 88 of 1984")

    const nca = normalise((await pageTexts(await renderSuretyship({ ...draft, ncaApplies: true }, "client-surety"))).flat().join(" "))
    expect(nca).toContain(`TEST Surety ("the Surety") is bound to the creditor`)
    for (const unlawful of ["prima facie", "Magistrates' Courts Act", "attorney and own client", "non causa debiti", "errore calculi"]) {
      expect(nca).not.toContain(unlawful)
    }
    expect(nca).toContain("Nothing in this deed limits any right the Surety has under the National Credit Act 34 of 2005")
  })

  it("is byte-identical when the same deal is rendered again (a sha256 binds what was signed)", async () => {
    expect(sha(await renderInstalmentSaleAgreement(draft))).toBe(sha(await renderInstalmentSaleAgreement(syntheticDealDocumentData())))
    expect(sha(await renderSuretyship(draft, "client-surety"))).toBe(sha(await renderSuretyship(draft, "client-surety")))
    const doc = await PDFDocument.load(await renderInstalmentSaleAgreement(draft))
    expect(doc.getCreationDate()?.toISOString()).toBe("2026-10-13T08:00:00.000Z")
  })

  it("prints the real parties, asset, pricing and the full schedule", async () => {
    const all = (await pageTexts(await renderInstalmentSaleAgreement(draft))).flat()
    expect(all).toEqual(expect.arrayContaining([
      "Test Asset Lender (Pty) Ltd", "2000/000000/07", "TEST Earthmoving (Pty) Ltd", "2099/000001/07",
      "TESTSERIAL0001", "TEST0000000000001", "TEST Plant Sales (Pty) Ltd",
      "R 1,500,000.00", "R 225,000.00", "R 172,500.00", "R 300,000.00", "TEST Director",
    ]))
    expect(all.join(" ")).toContain("Prime plus 1.00%")
    expect(all.join(" ")).toContain("11.75% a")
    for (const row of draft.schedule) expect(all).toContain(String(row.index + 1))
    expect(all).toContain("31 December 2030")
  })

  it("renders one suretyship per surety, naming only that surety", async () => {
    const mine = (await pageTexts(await renderSuretyship(draft, "client-surety"))).flat()
    expect(mine).toContain("TEST Surety")
    expect(mine).toContain("0000000000002")
    expect(mine).not.toContain("0000000000001")
    const other = await renderSuretyship(draft, "client-director")
    expect(sha(other)).not.toBe(sha(await renderSuretyship(draft, "client-surety")))
    await expect(renderSuretyship(draft, "client-stranger")).rejects.toBeInstanceOf(DealDocumentError)
  })

  it("titles the resolution for the entity type and lists the signatories", async () => {
    const company = (await pageTexts(await renderResolution(draft))).flat()
    expect(company).toContain("RESOLUTION OF THE BOARD OF DIRECTORS")
    expect(company).toContain("TEST Director")
    const trust = (await pageTexts(await renderResolution(syntheticDealDocumentData({
      entity: { ...draft.entity, type: "TRUST", legalName: "TEST Family Trust", mastersReference: "IT0000/2099" },
    })))).flat()
    expect(trust).toContain("RESOLUTION OF THE TRUSTEES")
    expect(trust).toContain("IT0000/2099")
    const trustText = normalise(trust.join(" "))
    expect(trustText).toContain("the trustees of the Trust, acting jointly as its trust deed requires")
    expect(trustText).toContain("TEST Family Trust (the \"Trust\")")
    expect(trustText).toContain("RESOLVED that the Trust enter into the agreement with Test Asset Lender (Pty) Ltd")
    expect(normalise(company.join(" "))).toContain("section 74 of the Companies Act 71 of 2008")
  })

  it("renders a name the standard fonts cannot encode instead of failing", async () => {
    const data = syntheticDealDocumentData({ entity: { ...draft.entity, legalName: "TEST !Xoǁkhoe Plant (Pty) Ltd" } })
    const { bytes, sha256 } = await renderDealDocument(data, "AGREEMENT", "client-director")
    expect(sha256).toBe(sha(bytes))
    expect((await pageTexts(bytes)).flat()).toContain("TEST !Xo?khoe Plant (Pty) Ltd")
  })
})
