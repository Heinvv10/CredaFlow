import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ClientPicker } from "@/components/wizard/ClientPicker"
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

// Fair Score acceptance (2026-10-17): the catalogue's R118 premium disagrees with the
// R268 the product's ACTIVE rate table produces for the client, so the server refused
// "Next". The 409 names the rated premium; the form offers it in one click.
describe("PolicyCreationWizard: rate-table premium", () => {
  const CLIENT = { id: "c1", email: "c1@example.test", firstName: "Syn", lastName: "Thetic" }
  const ADVISOR = { id: "a1", name: "Adviser", email: "a1@example.test" }

  function fillAndSubmit(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock)
    act(() => {
      renderer = create(<PolicyCreationWizard clients={[CLIENT]} advisors={[ADVISOR]} products={[PRODUCT]} />)
    })
    act(() => { renderer.root.findByProps({ name: "product", value: "prod-1" }).props.onChange() })
    act(() => { renderer.root.findByType(ClientPicker).props.onSelect("c1") })
    act(() => { renderer.root.findAllByType("select").find((s) => s.props.required)!.props.onChange({ target: { value: "a1" } }) })
  }

  const nextButton = () => renderer.root.findAllByType("button").find((b) => String(b.props.children).includes("Next"))!
  const useButton = () => renderer.root.findAllByType("button").find((b) => b.props.children?.toString().includes("Use R"))
  const premiumInput = () => renderer.root.findAllByType("input").find((i) => i.props.placeholder === "150")!
  const refuse = () => vi.fn(async () => Response.json(
    { error: "Requested premium 118.00 does not match the 268.00 the product's ACTIVE rate table produces for this client and cover", reason: "PREMIUM_MISMATCH", derivedPremium: "268.00" },
    { status: 409 },
  ))

  afterEach(() => vi.unstubAllGlobals())

  it("offers the rate-table premium after the server refuses the catalogue premium, and applies it in one click", async () => {
    fillAndSubmit(refuse())
    expect(useButton()).toBeUndefined()
    await act(async () => { nextButton().props.onClick() })
    expect(text()).toContain("does not match the 268.00")
    expect(useButton()?.props.children.join("")).toContain("Use R268.00")
    expect(premiumInput().props.value).toBe("118")

    act(() => { useButton()!.props.onClick() })
    expect(premiumInput().props.value).toBe("268.00")
    expect(useButton()).toBeUndefined()
    expect(text()).not.toContain("does not match the 268.00")
  })

  it("offers nothing for a refusal that is not a premium mismatch", async () => {
    fillAndSubmit(vi.fn(async () => Response.json({ error: "Client has no date of birth on record", reason: "NO_DATE_OF_BIRTH", derivedPremium: null }, { status: 409 })))
    await act(async () => { nextButton().props.onClick() })
    expect(text()).toContain("no date of birth")
    expect(useButton()).toBeUndefined()
  })
})
