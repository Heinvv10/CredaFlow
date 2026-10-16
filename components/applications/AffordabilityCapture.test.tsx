import { renderToStaticMarkup } from "react-dom/server"
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

describe("AffordabilityCapture own-lender loans", () => {
  const own = {
    lenderNames: ["Fair Score"],
    loans: [{ id: "loan-1", reference: "LN-ELIZE-1", status: "ACTIVE", instalmentCents: 254_100, outstandingPrincipal: 2_713_391, daysInArrears: 27, arrearsAmount: 84_330 }],
  }
  const render = (existingDebts: Parameters<typeof AffordabilityCapture>[0]["existingDebts"]) =>
    renderToStaticMarkup(
      <AffordabilityCapture
        applicationId="application-1"
        monthlyIncome={1_500_000}
        monthlyExpenses={800_000}
        existingDebts={existingDebts}
        clientDebtTotal={87_000 + 254_100}
        ownLenderDebts={own}
        proposedInstalment={200_000}
        done={false}
      />,
    ).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

  it("lists the own loan and counts it in the preview's existing debt", () => {
    const text = render([{ sourceId: "d1", creditor: "Store account", type: "RETAIL", monthlyInstalment: 87_000, balance: 400_000 }])
    expect(text).toContain("Loans with us (counted automatically) LN-ELIZE-1 with this lender, counted automatically R 2,541.00 / month")
    expect(text).toMatch(/Existing Debt - R 3[ ,]411[.,]00/)
  })

  it("does not count it twice when the application already declares it against the lender", () => {
    const text = render([
      { sourceId: "d1", creditor: "Store account", type: "RETAIL", monthlyInstalment: 87_000, balance: 400_000 },
      { sourceId: "d2", creditor: "Fair Score", type: "PERSONAL_LOAN", monthlyInstalment: 254_100, balance: 2_713_391 },
    ])
    expect(text).not.toContain("Loans with us")
    expect(text).toMatch(/Existing Debt - R 3[ ,]411[.,]00/)
  })
})
