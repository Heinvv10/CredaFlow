import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import Footer from "./Footer"
import { RegulatoryBand } from "./RegulatoryBand"

// A lender outside the NCA's jurisdiction holds no NCR number (LenderIdentity.ncrNumber is null).
const lesotho: LenderIdentity = { ...ACME_LENDER, ncrNumber: null, fspNumber: null }

describe("the website chrome of a lender with no NCR number", () => {
  it("footer prints no NCR line, and never the word null", () => {
    const html = renderToStaticMarkup(<Footer identity={lesotho} />)
    expect(html).not.toMatch(/NCR/)
    expect(html).not.toMatch(/null|undefined/)
    expect(html).toContain("Credit Provider")
  })

  it("regulatory band prints no NCR badge and never the word null", () => {
    const html = renderToStaticMarkup(<RegulatoryBand identity={lesotho} />)
    expect(html).not.toMatch(/NCR|null|undefined/)
  })

  it("both still print the NCR number when there is one", () => {
    expect(renderToStaticMarkup(<Footer identity={ACME_LENDER} />)).toContain("NCR Reg: NCRCP99999")
    expect(renderToStaticMarkup(<RegulatoryBand identity={ACME_LENDER} />)).toContain("NCRCP99999")
  })
})
