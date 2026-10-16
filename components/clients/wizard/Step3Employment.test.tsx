import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SA_BANKS } from "@/lib/banks"
import { EMPTY_CLIENT_WIZARD_DATA } from "./types"
import { Step3Employment } from "./Step3Employment"

const render = (bankName: string) => renderToStaticMarkup(
  <Step3Employment data={{ ...EMPTY_CLIENT_WIZARD_DATA, bankName }} patch={() => {}} errors={{}} mode="staff" />,
)

describe("Step3Employment bank name", () => {
  // Fair Score audit 2026-10-16: free text here, a dropdown in the portal.
  it("offers the one bank list as a dropdown, storing its code", () => {
    const html = render("")
    for (const bank of SA_BANKS) expect(html).toContain(`<option value="${bank.code}">${bank.label}</option>`)
  })

  it("selects a stored spelling's bank rather than showing it as free text", () => {
    expect(render("Capitec Bank Limited")).toMatch(/<option value="CAPITEC" selected="">Capitec<\/option>/)
  })
})
