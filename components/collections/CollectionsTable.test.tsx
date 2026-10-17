import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CollectionsTable } from "./CollectionsTable"
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("./Section129Button", () => ({ Section129Button: () => <span>S129</span> }))
vi.mock("./LogContactButton", () => ({ LogContactButton: () => null }))
vi.mock("./PaymentPlanButton", () => ({ PaymentPlanButton: () => null }))
vi.mock("./CollectionsWaButton", () => ({ CollectionsWaButton: () => null }))
vi.mock("./BulkAttorneyReferModal", () => ({ BulkAttorneyReferModal: () => null }))
let renderer: ReactTestRenderer
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { act(() => renderer.unmount()); environment.IS_REACT_ACT_ENVIRONMENT = false })
describe("collections table regulatory remedies", () => {
  it.each(["NCA", "NON_NCA"] as const)("renders the appropriate action for %s", (ncaRegime) => {
    environment.IS_REACT_ACT_ENVIRONMENT = true
    act(() => { renderer = create(<CollectionsTable activeTab="all" loans={[{
      id: "loan-synthetic", reference: "LN-SYNTHETIC", clientId: "client-synthetic", ncaRegime,
      daysInArrears: 137, arrearsAmount: 10000, client: { firstName: "Test", lastName: "Synthetic", phone: "0820000000" },
      product: { name: "Test", productType: "PERSONAL" }, notes: [], paymentPlan: null,
    }]} />) })
    const text = JSON.stringify(renderer.toJSON())
    if (ncaRegime === "NCA") expect(text).toContain('"S129"')
    else { expect(text).not.toContain('"S129"'); expect(text).toContain("Non-NCA — Section 129 does not apply") }
  })
})
