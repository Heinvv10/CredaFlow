import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { ExpenseBreakdownSection, type ExpenseBreakdownData } from "./ExpenseBreakdownSection"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const EMPTY: ExpenseBreakdownData = {
  housing: 0, transport: 0, food: 0, education: 0,
  insurance: 0, clothing: 0, entertainment: 0, medical: 0, other: 0,
}

function renderSection(onChange: (next: ExpenseBreakdownData) => void) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      <ExpenseBreakdownSection data={EMPTY} onChange={onChange} />,
    )
  })
  return renderer
}

// The conversion helper is unit-tested directly, but that cannot see this
// component: handleChange parses the raw input string into component state
// BEFORE randsToCents is ever reached, so a parseInt here truncates the cents
// where no helper test can observe it. Expense amounts are hashed into the same
// immutable approval fingerprint income feeds, so a lost cent invalidates an
// approved application exactly as a lost cent of income does.
describe("ExpenseBreakdownSection", () => {
  it("keeps the cents a user types into an expense field", () => {
    const onChange = vi.fn()
    const renderer = renderSection(onChange)
    const housing = renderer.root.findAllByType("input")
      .find((node) => node.props.id === "expense_housing")
    expect(housing).toBeDefined()

    act(() => {
      housing!.props.onChange({ target: { value: "1500.99" } })
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ housing: 1500.99 }),
    )
  })

  it("offers cent precision on every money field", () => {
    const renderer = renderSection(vi.fn())
    const moneyInputs = renderer.root.findAllByType("input")
      .filter((node) => String(node.props.id ?? "").startsWith("expense_"))
    expect(moneyInputs.length).toBeGreaterThan(0)
    for (const input of moneyInputs) {
      expect(input.props.step).toBe("0.01")
    }
  })

  it("treats an emptied field as zero rather than NaN", () => {
    const onChange = vi.fn()
    const renderer = renderSection(onChange)
    const food = renderer.root.findAllByType("input")
      .find((node) => node.props.id === "expense_food")

    act(() => {
      food!.props.onChange({ target: { value: "" } })
    })

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ food: 0 }))
  })
})
