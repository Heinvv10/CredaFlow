import { describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestInstance } from "react-test-renderer"
import { I18nProvider } from "@/lib/i18n/client"
import { CATALOGS } from "@/lib/i18n/catalog"
import { PortalDebitMandateClient } from "./PortalDebitMandateClient"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }))

// Row 118: generic mandate-page chrome is Afrikaans; the debit mandate's own
// wording (title, checkboxes, sign button) stays English (lib/i18n/.claude.md).
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ")

describe("debit mandate page in Afrikaans", () => {
  it("translates form chrome and keeps mandate wording English", async () => {
    const r = create(<span />)
    await act(async () => {
      r.update(
        <I18nProvider locale="af" messages={CATALOGS.af}>
          <PortalDebitMandateClient applicationId="a" reference="R" clientName="Test Client"
            initialBankDetails={{ bankName: "Nedbank", branchCode: "198765", accountNumber: "123456789", accountType: "SAVINGS" }}
            initialDraftSha256={"a".repeat(64)} initiallySigned={false} />
        </I18nProvider>,
      )
    })
    const out = text(r.root)
    for (const af of ["Rekeningnommer", "Takkode", "Rekeningtipe", "Jou handtekening"]) expect(out).toContain(af)
    for (const en of ["Account number", "Branch code", "Your signature"]) expect(out).not.toContain(en)
    expect(out).toContain("Repayment bank details")
    expect(out).toContain("Prepare mandate")
    expect(out).toContain("I authorise the creditor to issue the payment instructions described in the mandate.")
    expect(out).toContain("Authorise and sign mandate")
  })
})
