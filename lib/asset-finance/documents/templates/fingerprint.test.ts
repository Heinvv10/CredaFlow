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
  "af.isa.commercial": "99337242e1014e6e62265185e669b1604b0183f453b463c97533a697621f2910",
  "af.isa.cpa": "ebe0d4c172fd638bca5073e05d47994761966fb927c2d58b3f6732636c909cec",
  "af.lease.operating.commercial": "7133138a313e6f7e7c8ca67ee2f86b7819874211cf5c9df4706ae714b054e1f5",
  "af.lease.operating.cpa": "b4428d8d1d9f30c9f82f2bd441cd7f07af512846f26d90a126a8fa3d058c9a0b",
  "af.lease.fml.commercial": "160b49745dc2e679276b00e8598ea0b8a3254b039ef1abab0a8aaa2a783c5841",
  "af.lease.fml.cpa": "266f5c3bf5dd7d1ce49052169d232110c6c954bc93c3d6c77d94dbfde4c6c2a7",
  "af.nca.instalment_sale": "edb5b49d88cb547eb8f105972a9b619f14c58e490fdf0c2b1225a820ae2e75bb",
  "af.nca.finance_lease": "c868e66750d2a71489b4f819f6fa69550690f9df71cd7f731735774bfb72cff2",
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
    "af.isa.commercial": ["fixed for the whole term", "ZARONIA", "Repo", "JIBAR", "below the reference rate", "the Contract Rate in force from time to time.", "No default interest is charged", "No collection fee is charged", "address notified to the Seller in writing"],
    "af.lease.fml.commercial": ["The rental does not escalate", "which does not escalate", "km a year", "hours a year", "No default interest is charged on late payments", "monthly in advance", "keeps any surplus in the fund"],
    "af.lease.operating.cpa": ["section 14", "No usage limit is contracted", "km a year", "Repo", "JIBAR", "ZARONIA", "Lender base rate"],
    "af.lease.operating.commercial": ["Repo", "JIBAR", "ZARONIA", "Lender base rate", "Prime"],
    "af.nca.instalment_sale": ["Credit Life Insurance Regulations", "No credit-life premium is payable", "a small agreement", "a large agreement", "fixed for the whole term", "linked to Repo", "linked to JIBAR", "linked to ZARONIA", "linked to Lender base rate"],
    "af.nca.finance_lease": ["linked to Repo", "linked to JIBAR", "linked to ZARONIA", "linked to Lender base rate"],
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
