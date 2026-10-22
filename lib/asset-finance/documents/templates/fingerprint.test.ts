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
  "af.isa.commercial": "86e5629d27b8d2b908ad712062e1ca7725cf6f8d13b90c06de41a66c2c45222b",
  "af.isa.cpa": "811c6e52c95d518f33f8e0977de8e05981c46113524d501d6be0b414dd7a1ec0",
  "af.lease.operating.commercial": "741a608ec5407a90d3a824f2ebc52b2c59e6281cbb4893152050479612dce54f",
  "af.lease.operating.cpa": "7c13830e26b263117d1e9b6b968f7faae95a1ee2b7b4c8908445f46411260eb3",
  "af.lease.fml.commercial": "3e6bf1f8b37d1ed36a771462b180bef6b2e9323fb95d55c370406798cb15301b",
  "af.lease.fml.cpa": "ec1b899bf7b6b236d6964f195e542e4476aa0c1b01ee5862379b01977ce34d2c",
  "af.nca.instalment_sale": "1bee05ba54722eb90e912f2614ce317cf470d6fb36edf6da66201d184357f009",
  "af.nca.finance_lease": "e89a635f95a57bc5aaf883fa87cebab8724732267d7ef461509e3dc76c649ff4",
  "af.suretyship.commercial": "3075411b27f65252533ecefe9ba33bd534370ad2e219057359387df408ff2568",
  "af.suretyship.nca": "512b350acdd4189f62c56148bc7a931ba083e44b7b8bc436cad389515a76632d",
  "af.resolution.standard": "17f7807d1a724c350c7ad903ade3dabac1fbd65739ddb082859bccdc547fcba6",
}

describe("protected-output fingerprints", () => {
  it("are pinned for SYSTEM_REVISION 2026-10-22.1", async () => {
    expect(SYSTEM_REVISION).toBe("2026-10-22.1")
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
    "af.isa.commercial": ["fixed for the whole term", "ZARONIA", "Repo", "JIBAR", "below the reference rate", "the Contract Rate in force from time to time.", "No default interest is charged", "No collection fee is charged", "address notified to the Seller in writing", "Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The Seller may pay a commission to the introducer named above"],
    "af.isa.cpa": ["Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The Seller may pay a commission to the introducer named above"],
    "af.lease.fml.commercial": ["The rental does not escalate", "which does not escalate", "km a year", "hours a year", "No default interest is charged on late payments", "monthly in advance", "keeps any surplus in the fund", "Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The lessor may pay a commission to the introducer named above"],
    "af.lease.operating.cpa": ["section 14", "No usage limit is contracted", "km a year", "Repo", "JIBAR", "ZARONIA", "Lender base rate", "Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The lessor may pay a commission to the introducer named above"],
    "af.lease.operating.commercial": ["Repo", "JIBAR", "ZARONIA", "Lender base rate", "Prime", "Contract rate (no added margin)", "at the contract rate, calculated daily", "Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The lessor may pay a commission to the introducer named above"],
    "af.lease.fml.cpa": ["Contract rate (no added margin)", "at the contract rate, calculated daily", "Introducer SAMPLE Dealer (synthetic) (dealer) Introducer's commission. The lessor may pay a commission to the introducer named above"],
    "af.nca.instalment_sale": ["Credit Life Insurance Regulations", "No credit-life premium is payable", "a small agreement", "a large agreement", "fixed for the whole term", "linked to Repo", "linked to JIBAR", "linked to ZARONIA", "linked to Lender base rate", "COMMISSION TO THE INTRODUCER Introducer SAMPLE Dealer (synthetic) (dealer) The Credit Provider may pay a commission to the introducer named above"],
    "af.nca.finance_lease": ["linked to Repo", "linked to JIBAR", "linked to ZARONIA", "linked to Lender base rate", "COMMISSION TO THE INTRODUCER Introducer SAMPLE Dealer (synthetic) (dealer) The Credit Provider may pay a commission to the introducer named above"],
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
