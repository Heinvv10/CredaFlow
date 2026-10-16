import { renderToStaticMarkup } from "react-dom/server"
import { act, create } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { AffordabilityCapture } from "./AffordabilityCapture"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

describe("AffordabilityCapture corrupt debt repair state", () => {
  it("does not present invalid persisted debt as a zero-debt affordability result", () => {
    const html = renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={[]}
        clientDebtTotal={0}
        proposedInstalment={200_000}
        done={true}
        debtEvidenceInvalid={true}
      />,
    )

    expect(html).toContain("Stored debt evidence is invalid")
    expect(html).toContain("affordability is not calculated")
    expect(html).not.toContain(">AFFORDABLE<")
    expect(html).not.toContain("Existing Debt</p>")
    expect(html).toContain("Risk Grade")
    expect(html).toContain("Unavailable")
    for (const grade of ["A", "B", "C", "D"]) {
      expect(html).not.toContain(`>${grade}<`)
    }
    expect(html).toContain("Save an empty list only after confirming")
  })

  it("hides derived indicators when the client debt aggregate is invalid", () => {
    const html = renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={[]}
        clientDebtTotal={0}
        proposedInstalment={200_000}
        done={true}
        clientDebtEvidenceInvalid={true}
      />,
    )

    expect(html).toContain("Stored client debt evidence is invalid")
    expect(html).toContain("client financial profile")
    expect(html).toContain("Unavailable")
    expect(html).toContain("Client Debt Repair Required")
    expect(html).not.toContain(">AFFORDABLE<")
    for (const grade of ["A", "B", "C", "D"]) {
      expect(html).not.toContain(`>${grade}<`)
    }
  })

  it("hides derived indicators when application debt rows overflow in aggregate", () => {
    const html = renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={[
          {
            creditor: "Synthetic Bank A",
            type: "PERSONAL_LOAN",
            balance: 0,
            monthlyInstalment: 1_500_000_000,
          },
          {
            creditor: "Synthetic Bank B",
            type: "PERSONAL_LOAN",
            balance: 0,
            monthlyInstalment: 1_500_000_000,
          },
        ]}
        clientDebtTotal={0}
        proposedInstalment={200_000}
        done={true}
        debtEvidenceInvalid={true}
      />,
    )

    expect(html).toContain("affordability is not calculated")
    expect(html).toContain("Unavailable")
    expect(html).not.toContain(">AFFORDABLE<")
    expect(html).not.toContain(">NOT AFFORDABLE<")
    for (const grade of ["A", "B", "C", "D"]) {
      expect(html).not.toContain(`>${grade}<`)
    }
  })
})

describe("AffordabilityCapture account-type rendering", () => {
  // The reported defect: a stored value from another vocabulary matched no
  // <option>, so the browser displayed the FIRST one — "Home loan" — and staff
  // read a home loan where the record said personal_loan. Selecting the right
  // option is not enough; the WRONG one must not be the one selected.
  it("selects the matching option for a legacy lower_snake value", () => {
    const html = renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={[{
          sourceId: "d1",
          creditor: "nimble",
          type: "personal_loan",
          monthlyInstalment: 40_000,
          balance: 0,
        }]}
        clientDebtTotal={40_000}
        proposedInstalment={200_000}
        done={false}
      />,
    )

    expect(html).toContain('value="PERSONAL_LOAN" selected=""')
    expect(html).not.toContain('value="HOME_LOAN" selected=""')
    expect(html).not.toContain("Unrecognised")
  })

  it("names an unrecognised value instead of silently selecting the first option", () => {
    const html = renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={[{
          sourceId: "d1",
          creditor: "nimble",
          type: "BOAT_FINANCE",
          monthlyInstalment: 40_000,
          balance: 0,
        }]}
        clientDebtTotal={40_000}
        proposedInstalment={200_000}
        done={false}
      />,
    )

    expect(html).toContain("Unrecognised (BOAT_FINANCE)")
    expect(html).not.toContain('value="HOME_LOAN" selected=""')
  })
})

// #140 review: an edited, unsaved debt list could read AFFORDABLE beside a
// rail that (from the saved figures) says "Not affordable".
describe("AffordabilityCapture unsaved preview", () => {
  it("says the approval checks use the saved figures once a debt is edited", async () => {
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    env.IS_REACT_ACT_ENVIRONMENT = true
    let r!: ReturnType<typeof create>
    await act(async () => {
      r = create(<AffordabilityCapture applicationId="application-1" monthlyIncome={1_500_000} monthlyExpenses={800_000}
        existingDebts={[]} clientDebtTotal={0} proposedInstalment={200_000} done={true} />)
    })
    const text = () => JSON.stringify(r.toJSON())
    expect(text()).not.toContain("Unsaved changes")
    const add = r.root.findAll((n) => n.type === "button" && [n.props.children].flat(3).includes("Add creditor"))[0]
    await act(async () => add.props.onClick())
    expect(text()).toContain("Unsaved changes: save to update the approval checks.")
    delete env.IS_REACT_ACT_ENVIRONMENT
  })
})
