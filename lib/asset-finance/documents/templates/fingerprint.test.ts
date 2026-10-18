// The protected output of every lender-template variant, pinned with
// SYSTEM_REVISION. A change here means CredaFlow changed what it prints around
// the lenders' approved wording: every lender's approval of that variant lapses
// (fingerprint.ts) and must be given again. So when this fails, either revert
// the change, or bump SYSTEM_REVISION in families.ts, re-pin these values,
// record why in docs/asset-finance/DESIGN.md, and have each lender re-approve.
import { describe, expect, it } from "vitest"
import { ALL_TEMPLATE_KEYS, SYSTEM_REVISION } from "./families"
import { systemFingerprint } from "./fingerprint"

const PINNED: Record<string, string> = {
  "af.isa.commercial": "5f4f83e864af017fb12b76c0486f5326b69478af0f731c462243dc343b5ea426",
  "af.isa.cpa": "463b343c777cc009007f2b695f18034b00def5833ce2b8403894150e7254f651",
  "af.lease.operating.commercial": "4d53db30c53d761ac4ba427d2e501b2ec737f3108a9a836f15b18117c6cf986f",
  "af.lease.operating.cpa": "49bced1dfe350025fc3ecfb53cf0d4f1a9bc971b0ef0a0e2a5f0e4eadf921fbd",
  "af.lease.fml.commercial": "523b5b983e642db41b1e713b8240302a23bdeb82a6671b7dcdab098374973ba6",
  "af.lease.fml.cpa": "bac41e5dd83a517853bba9c0e5890ea0c6a4c2a24ccd2fff8b0dc1d351d9609d",
  "af.nca.instalment_sale": "02aa1e200564c00e950957c08e911056a53a328fa3703105132840db6f4046a1",
  "af.nca.finance_lease": "70023569fef400ef616e4cbecfcbb705707f4634062118f5742621b946165081",
  "af.suretyship.commercial": "77c27a42789a42ea81e8509ce0a009d4caaac2c6619dac5f9487b7f93289984f",
  "af.suretyship.nca": "4c9c47c02aab81023162c0a1232a5f3133f9cce345be479f7889059578d2ffc9",
  "af.resolution.standard": "1d214e15596a8a5c58f2e18af852ccfd76d3d26305fc0c03ebb341d0ffa77d4c",
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
})
