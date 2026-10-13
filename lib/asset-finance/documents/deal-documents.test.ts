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

  it("omits the watermark once the legal wording is approved, and the bytes differ", async () => {
    const off = await renderInstalmentSaleAgreement(draft)
    const on = await renderInstalmentSaleAgreement(approved)
    for (const page of await pageTexts(on)) expect(page).not.toContain(DRAFT_WATERMARK)
    expect(sha(on)).not.toBe(sha(off))
  })

  it("marks every clause as a placeholder for the legal team", async () => {
    for (const bytes of [
      await renderInstalmentSaleAgreement(draft),
      await renderResolution(draft),
      await renderSuretyship(draft, "client-surety"),
    ]) {
      const all = (await pageTexts(bytes)).flat()
      expect(all.filter((t) => t === PLACEHOLDER_CLAUSE).length).toBeGreaterThanOrEqual(3)
    }
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
  })

  it("renders a name the standard fonts cannot encode instead of failing", async () => {
    const data = syntheticDealDocumentData({ entity: { ...draft.entity, legalName: "TEST !Xoǁkhoe Plant (Pty) Ltd" } })
    const { bytes, sha256 } = await renderDealDocument(data, "AGREEMENT", "client-director")
    expect(sha256).toBe(sha(bytes))
    expect((await pageTexts(bytes)).flat()).toContain("TEST !Xo?khoe Plant (Pty) Ltd")
  })
})
