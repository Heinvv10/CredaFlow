// @vitest-environment jsdom
// Typing a figure into the calculator's amount or term field must keep what the
// visitor types. The field used to show the clamped quote value on every
// keystroke, so the first digit of "1500" was clamped up to the minimum and the
// rest appended to it (1500 became the product maximum).
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LivePricing } from "@/lib/public-loan-products"

const live: LivePricing = {
  interestRatePm: 0.05, interestModel: "REDUCING_BALANCE" as LivePricing["interestModel"],
  initiationFeePct: 0.1, initiationFeeMax: 1000, monthlyServiceFee: 60,
  minAmount: 100_000, maxAmount: 1_000_000, minTermDays: 90, maxTermDays: 720,
}
vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: () => ({ pricing: { personal: live }, loading: false }) }))

import { ProductLoanCalculator } from "./ProductLoanCalculator"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<ProductLoanCalculator variant="full" defaultProduct="personal" />) })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete env.IS_REACT_ACT_ENVIRONMENT
})

const field = (id: string) => container.querySelector<HTMLInputElement>(`#full-product-${id}`)!
const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

async function input(el: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

/** Clears the field, then types `text` one key at a time: each key appends to
 * whatever the field shows at that moment, as it does for a person. */
async function type(el: HTMLInputElement, text: string) {
  await act(async () => { el.focus() })
  await input(el, "")
  for (const key of text) await input(el, el.value + key)
}
async function blur(input: HTMLInputElement) {
  await act(async () => { input.blur() })
}

describe("calculator typed entry", () => {
  it("keeps a typed amount and quotes on it", async () => {
    await type(field("amount"), "1500")
    expect(field("amount").value).toBe("1500")
    await blur(field("amount"))
    expect(field("amount").value).toBe("1500")
    expect(container.textContent).toMatch(/PrincipalR\s1,500\.00/)
  })

  it("clamps an out-of-range amount only when the visitor leaves the field", async () => {
    await type(field("amount"), "50")
    expect(field("amount").value).toBe("50")
    await blur(field("amount"))
    expect(field("amount").value).toBe("1000")
  })

  it("keeps a typed term", async () => {
    await type(field("term"), "12")
    expect(field("term").value).toBe("12")
    await blur(field("term"))
    expect(field("term").value).toBe("12")
  })
})
