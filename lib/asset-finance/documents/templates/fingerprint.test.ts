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

const PINNED: Record<string, string> = {
  "af.isa.commercial": "b99404c9059b6bc1d9864d3f30eafa76507ac1b38afcec4e9357ff081de9eaae",
  "af.isa.cpa": "a0f574ab4d79d13d1fe6a44e8843a0f201d5a56b895dffc4407308f16d540ce2",
  "af.lease.operating.commercial": "112a646c180a158da035758a5661917431217ac963ba019655e706f10c10d729",
  "af.lease.operating.cpa": "e383d36712146d7280428999685108a98ee5cd60baf9e65c089a4cac96f46d92",
  "af.lease.fml.commercial": "f9fb82469e436c525a2d903fe09138a0bf5777383c082a44f6b12f1648827c16",
  "af.lease.fml.cpa": "e5f4a1cce6dde92caeaadd115907a7775e818f7816ed0f9ecb7a9f4d93cc2b08",
  "af.nca.instalment_sale": "b64571461f6bbd3e7379a00f26f458cbbab789120dc888d608ef7bfc17e146f7",
  "af.nca.finance_lease": "ee447c344291639aaf4525bb82efed89b8c9b50b9d162afab6065cf6daaf890d",
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
})
