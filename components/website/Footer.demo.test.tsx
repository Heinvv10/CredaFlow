import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import Footer from "./Footer"

afterEach(() => vi.unstubAllEnvs())

describe("site footer registration strip", () => {
  it("labels a demo lender's NCR and FSP numbers as fictional on a demo stack", () => {
    vi.stubEnv("DEMO_MODE", "true")
    const html = renderToStaticMarkup(<Footer identity={ACME_LENDER} />)
    expect(html).toMatch(/NCR Reg: NCRCP99999 · FSP: 12345 · Demo lender: registration numbers are fictional\./)
  })

  it("prints the numbers alone for a real lender", () => {
    const html = renderToStaticMarkup(<Footer identity={ACME_LENDER} />)
    expect(html).toContain("NCR Reg: NCRCP99999")
    expect(html).not.toContain("Demo lender")
  })
})
