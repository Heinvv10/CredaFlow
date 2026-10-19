import { describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestInstance } from "react-test-renderer"
import { I18nProvider } from "@/lib/i18n/client"
import { CATALOGS } from "@/lib/i18n/catalog"
import { DealSignClient } from "./DealSignClient"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }))

// Row 118: the signing-code step on the deal page is Afrikaans; the
// read-confirmation and sign button are consent text and stay English.
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ")

describe("deal signing page in Afrikaans", () => {
  it("translates the code step and keeps the consent line English", async () => {
    const r = create(<span />)
    await act(async () => {
      r.update(
        <I18nProvider locale="af" messages={CATALOGS.af}>
          <DealSignClient signerId="s" documentSha256={"a".repeat(64)} documentLabel="Finance Lease"
            signingOtp={{ required: true, channels: ["EMAIL"] }} />
        </I18nProvider>,
      )
    })
    const out = text(r.root)
    expect(out).toContain("Bevestig dis jy")
    expect(out).toContain("Stuur kode per e-pos")
    expect(out).not.toContain("Confirm it")
    expect(out.replace(/\s+/g, " ")).toContain("I have read the finance lease above and I am signing it electronically.")
    expect(out).toContain("Sign electronically")
  })
})
