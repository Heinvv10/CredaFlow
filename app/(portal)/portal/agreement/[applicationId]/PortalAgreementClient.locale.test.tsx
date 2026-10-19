import { describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestInstance } from "react-test-renderer"
import { I18nProvider } from "@/lib/i18n/client"
import { CATALOGS } from "@/lib/i18n/catalog"
import { PortalAgreementClient, AgreementSignedPanel } from "./PortalAgreementClient"

vi.mock("@/lib/toast", () => ({ toast: {} }))

// Row 118: the signing page chrome stayed English under an Afrikaans portal.
// Consent text (the declarations and the sign button) is a separate PR.
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")

const withAf = (ui: React.ReactElement) => (
  <I18nProvider locale="af" messages={{ portalSigning: CATALOGS.af.portalSigning }}>{ui}</I18nProvider>
)

describe("portal agreement page in Afrikaans", () => {
  it("renders headings, hints and signature controls in Afrikaans", async () => {
    const r = create(<span />)
    await act(async () => {
      r.update(withAf(
        <PortalAgreementClient
          applicationId="app-1" reference="CF-1" clientName="Test Client" agreementDocumentSha256={null}
          agreementExecutedDocumentId={null} pasqDocumentSha256={null} repaymentMethod="EFT"
        />,
      ))
    })
    const out = text(r.root)
    for (const af of ["PASQ + Kredietooreenkoms", "Test Client — Aansoek CF-1", "Verbruikersverklaring", "Jou handtekening", "Teken hier", "Maak PDF in ’n nuwe oortjie oop"]) {
      expect(out).toContain(af)
    }
    for (const en of ["Consumer Declaration", "Your Signature", "Sign here", "Open PDF in a new tab", "Application CF-1"]) {
      expect(out).not.toContain(en)
    }
  })

  it("renders the signed panel in Afrikaans", async () => {
    const r = create(<span />)
    await act(async () => {
      r.update(withAf(<AgreementSignedPanel applicationId="app-1" agreementExecutedDocumentId={null} mandateRequired />))
    })
    const out = text(r.root)
    expect(out).toContain("Ooreenkoms geteken")
    expect(out).toContain("Stel terugbetaling op")
    expect(out).not.toContain("Agreement signed")
  })
})
