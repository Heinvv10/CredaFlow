import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Step1ClientSelect } from "./Step1ClientSelect"
import { Step3Affordability } from "./Step3Affordability"
import { EMPTY_APPLICATION_WIZARD_DATA } from "./types"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }))

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
const elize = { days: 27, amountCents: 84_330 }

describe("staff new-application wizard: in arrears with us", () => {
  it("warns on the client step once a client in arrears with this lender is chosen", () => {
    const html = text(renderToStaticMarkup(
      <Step1ClientSelect data={EMPTY_APPLICATION_WIZARD_DATA} patch={() => {}} errors={{}} mode="staff" clients={[]} selectedClientArrears={elize} />,
    ))
    expect(html).toContain("In arrears with us: 27 days, R 843.30.")
  })

  it("warns on the affordability step, and says nothing for a client who is up to date", () => {
    const step3 = (ownLenderArrears: typeof elize | null) => text(renderToStaticMarkup(
      <Step3Affordability
        data={EMPTY_APPLICATION_WIZARD_DATA}
        patch={() => {}}
        errors={{}}
        mode="staff"
        products={[]}
        selectedClient={{ monthlyIncome: 1_500_000, monthlyExpenses: 800_000, debtObligations: [], ownLenderArrears }}
      />,
    ))
    expect(step3(elize)).toContain("In arrears with us: 27 days, R 843.30.")
    expect(step3(null)).not.toContain("In arrears with us")
  })
})
