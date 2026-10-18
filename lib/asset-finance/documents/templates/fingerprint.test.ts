// The protected output of every lender-template variant, pinned with
// SYSTEM_REVISION. A change here means CredaFlow changed what it prints around
// the lenders' approved wording: every lender's approval of that variant lapses
// (fingerprint.ts) and must be given again. So when this fails, either revert
// the change, or bump SYSTEM_REVISION in families.ts, re-pin these values,
// record why in docs/asset-finance/DESIGN.md, and have each lender re-approve.
// Treat it as a release event: from deploy, published versions of the
// variant stop issuing until re-approved. A pdf-lib, font or preview-fixture
// change moves these values too, with the same consequence.
import { describe, expect, it } from "vitest"
import { ALL_TEMPLATE_KEYS, SYSTEM_REVISION } from "./families"
import { systemFingerprint } from "./fingerprint"
import { starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { previewShapes, renderTemplatePreview } from "./preview"
import { prose, texts } from "../nca/nca-wording.test-helpers"

const PINNED: Record<string, string> = {
  "af.isa.commercial": "eaa18d5e6975d1c61c01eddf00278944bfe69022694fdf1d6364a146cf7fa0cd",
  "af.isa.cpa": "d00def8714fb50d147df48515555b1b239f3f46438708a6c6f29eaa48ee555cb",
  "af.lease.operating.commercial": "35e5aa47a9a7000009689ab7311b1e7db496ab36401427034d5298fc8fd424aa",
  "af.lease.operating.cpa": "71a374227ddba1b2c26b80e7160c6b5356fd62ebbeb2710ed47f6a9cc61ec13e",
  "af.lease.fml.commercial": "48a1b86406ebb48d01f5646e4bbf9e663e83984d5d3e5e7c7ec4030d98fb248b",
  "af.lease.fml.cpa": "9b3e719e3615c44b9fa94f9f328376ed2d92f0a537a9512cd2943c1d0d96e05e",
  "af.nca.instalment_sale": "b666ea7921c03a1b3cdb040891b2065dfa3fe88130ab4698c997e37a63e9c1a2",
  "af.nca.finance_lease": "8612891289dbd78615640d7c11e8a4cae5e6615d20797a06fe5ccf1c1c1d3f35",
  "af.suretyship.commercial": "3075411b27f65252533ecefe9ba33bd534370ad2e219057359387df408ff2568",
  "af.suretyship.nca": "512b350acdd4189f62c56148bc7a931ba083e44b7b8bc436cad389515a76632d",
  "af.resolution.standard": "17f7807d1a724c350c7ad903ade3dabac1fbd65739ddb082859bccdc547fcba6",
}

describe("protected-output fingerprints", () => {
  it("are pinned for SYSTEM_REVISION 2026-10-18.1", async () => {
    expect(SYSTEM_REVISION).toBe("2026-10-18.1")
    const current = Object.fromEntries(await Promise.all(ALL_TEMPLATE_KEYS.map(async (key) => [key, await systemFingerprint(key)] as const)))
    expect(current).toEqual(PINNED)
  }, 60_000)

  it("do not depend on the lender's own text", async () => {
    // The fingerprint renders fixed placeholder text: the same value whatever any lender wrote.
    expect(await systemFingerprint("af.isa.commercial")).toBe(PINNED["af.isa.commercial"])
    await expect(systemFingerprint("af.unknown.key")).rejects.toThrow(/Not an asset-finance template/)
  })

  it("every deal shape of every variant renders different protected output, so each one is covered", async () => {
    const lender = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Street", "Town"] }
    for (const key of ALL_TEMPLATE_KEYS) {
      const shapes = previewShapes(key)
      expect(shapes.length, key).toBeGreaterThanOrEqual(2)
      const content = starterContent(parseTemplateKey(key)!)
      const hashes = new Set<string>()
      for (const shape of shapes) hashes.add((await renderTemplatePreview(key, content, lender, shape.id)).toString("base64"))
      expect(hashes.size, key).toBe(shapes.length)
    }
  }, 120_000)

  // Text that prints only on one branch of the protected wording. Each must
  // appear in some fingerprinted shape, or a change to it would not lapse
  // approvals. Add a marker (and a shape) when adding a branch.
  const BRANCHES: Record<string, string[]> = {
    "af.isa.commercial": ["fixed for the whole term", "ZARONIA", "Repo", "JIBAR", "below the reference rate", "the Contract Rate in force from time to time.", "No default interest is charged", "No collection fee is charged"],
    "af.lease.fml.commercial": ["The rental does not escalate", "which does not escalate", "km a year", "hours a year", "No default interest is charged on late payments", "monthly in advance", "keeps any surplus in the fund"],
    "af.lease.operating.cpa": ["section 14", "No usage limit is contracted", "km a year"],
    "af.nca.instalment_sale": ["Credit Life Insurance Regulations", "No credit-life premium is payable", "a small agreement", "a large agreement", "fixed for the whole term"],
    "af.suretyship.nca": ["the physical address to be recorded"],
    "af.resolution.standard": ["Trust Property Control Act", "RESOLUTION OF THE TRUSTEES", "RESOLUTION OF THE MEMBERS", "RESOLUTION OF THE PARTNERS", "acting together"],
  }
  it.each(Object.entries(BRANCHES))("%s: every listed protected branch is in a fingerprinted shape", async (key, markers) => {
    const lender = { legalName: "Shape Lender (Pty) Ltd", tradingName: "Shape", companyRegNumber: "2000/000000/07", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Street", "Town"] }
    const content = starterContent(parseTemplateKey(key)!)
    const all: string[] = []
    for (const shape of previewShapes(key)) all.push(prose(await texts(await renderTemplatePreview(key, content, lender, shape.id))).replace(/\s+/g, " "))
    for (const marker of markers) expect(all.some((text) => text.includes(marker)), `${key}: ${marker}`).toBe(true)
  }, 120_000)
})
