import { act, create, type ReactTestInstance } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/client"
import { CATALOGS } from "@/lib/i18n/catalog"
import { SigningOtpStep } from "./SigningOtpStep"

// Row 118: the signing code step showed English under an Afrikaans portal.
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")

async function mountAf(channels: ("EMAIL" | "WHATSAPP")[]) {
  const r = create(<span />)
  await act(async () => {
    r.update(
      <I18nProvider locale="af" messages={{ portalSigning: CATALOGS.af.portalSigning }}>
        <SigningOtpStep purpose="AGREEMENT" subjectId="a" documentSha256={null} channels={channels} onVerified={() => {}} />
      </I18nProvider>,
    )
  })
  return r
}

describe("SigningOtpStep in Afrikaans", () => {
  it("renders the heading and send buttons in Afrikaans", async () => {
    const out = text((await mountAf(["EMAIL", "WHATSAPP"])).root)
    expect(out).toContain("Bevestig dis jy")
    expect(out).toContain("Stuur kode per e-pos")
    expect(out).toContain("Stuur kode per WhatsApp")
    expect(out).not.toContain("Confirm it")
    expect(out).not.toContain("Send code")
  })

  it("renders the no-channel notice in Afrikaans", async () => {
    const out = text((await mountAf([])).root)
    expect(out).toContain("Ons het nie ’n e-posadres of WhatsApp-nommer")
  })
})
