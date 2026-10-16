import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PolicyCreationWizard } from "./PolicyCreationWizard"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

// Fair Score audit (2026-10-16): the funeral product pre-filled the insurer
// "Guardrisk Life" (a real insurer, implying a partnership the lender does not
// have), and the form showed "Commission: R 4 000,00" — 20% of the R20 000 sum
// assured on a R118/month policy.
const PRODUCT = {
  id: "prod-1", name: "Family Funeral Plan", type: "FUNERAL_COVER", code: "FUN-1",
  premiumAmount: 118, sumAssured: 20_000, commissionRate: 0.2, active: true,
  insurerName: "Example Underwriters (fictional)",
}

let renderer: ReactTestRenderer

function render(products = [PRODUCT]) {
  act(() => {
    renderer = create(<PolicyCreationWizard clients={[]} advisors={[]} products={products} />)
  })
}

function insurerInput(): ReactTestInstance {
  return renderer.root.findByProps({ "aria-label": "Insurer" })
}

function text(): string {
  const parts: string[] = []
  const walk = (node: ReturnType<ReactTestRenderer["toJSON"]>) => {
    if (node === null) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === "string") return void parts.push(node)
    node.children?.forEach((child) => walk(child as never))
  }
  walk(renderer.toJSON())
  return parts.join("")
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { act(() => renderer.unmount()) })

describe("PolicyCreationWizard: insurer and commission", () => {
  it("pre-fills no insurer name of its own", () => {
    render([])
    expect(insurerInput().props.value).toBe("")
    act(() => {
      renderer.root.findAllByType("select").find((s) => s.props.value === "FUNERAL_COVER")!.props.onChange({ target: { value: "SHORT_TERM_MOTOR" } })
    })
    expect(insurerInput().props.value).toBe("")
  })

  it("takes the insurer from the catalogue product the lender configured", () => {
    render()
    act(() => {
      renderer.root.findByProps({ name: "product", value: "prod-1" }).props.onChange()
    })
    expect(insurerInput().props.value).toBe("Example Underwriters (fictional)")
  })

  it("shows the commission on the premium, not on the sum assured", () => {
    render()
    act(() => {
      renderer.root.findByProps({ name: "product", value: "prod-1" }).props.onChange()
    })
    // R118.00 x 20% = R23.60 a month.
    expect(text()).toContain("Commission: R 23.60 a month")
    expect(text()).not.toMatch(/Commission: R 4[\s, ]?000/)
  })
})
