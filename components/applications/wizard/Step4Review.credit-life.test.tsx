import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Step4Review } from "./Step4Review"
import { EMPTY_APPLICATION_WIZARD_DATA, type ApplicationWizardData } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const DATA: ApplicationWizardData = {
  ...EMPTY_APPLICATION_WIZARD_DATA,
  clientId: "c1", productId: "p1", appliedAmount: "30000", appliedTermDays: "540", purpose: "home repairs",
  affordabilityFlag: "PASS",
}
const PRODUCT = {
  id: "p1", name: "Personal Loan", minAmount: 200_000, maxAmount: 10_000_000, minTermDays: 90, maxTermDays: 1800,
  interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" as const, initiationFeePct: 0.165, initiationFeeMax: 108_000, monthlyServiceFee: 6900,
}

// The audit: staff and portal both showed a disabled "Add the offered
// credit-life cover" radio next to "cover is not available".
describe("Step4Review when credit-life cover is not available", () => {
  let renderer!: ReactTestRenderer
  const patch = vi.fn()

  async function mount(data: ApplicationWizardData) {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <Step4Review data={data} patch={patch} errors={{}} mode="staff" editJump={() => undefined}
          clients={[{ id: "c1", firstName: "Synthetic", lastName: "Client", email: "s@example.test" }] as never}
          products={[PRODUCT] as never}
          creditLifeOffer={{ productId: "cl", productName: "Synthetic CL", insurerId: "i", insurerName: "Synthetic Insurer", autoBundleEnabled: false }}
        />,
      )
    })
  }

  afterEach(async () => {
    await act(async () => renderer.unmount())
    patch.mockReset()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("offers no election radio", async () => {
    await mount(DATA)
    expect(renderer.root.findAllByType("input").filter((i) => i.props.type === "radio")).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).toContain("Credit-life cover is not available for this application")
  })

  it("records proceeding without cover when staff acknowledge it", async () => {
    await mount(DATA)
    const ack = renderer.root.findAllByType("input").find((i) => i.props.type === "checkbox" && i.props.checked === false && !i.props.disabled)!
    await act(async () => ack.props.onChange({ target: { checked: true } }))
    expect(patch).toHaveBeenCalledWith({ creditLifeDisclosureAcknowledged: true, creditLifeElection: "DECLINED" })
  })
})
