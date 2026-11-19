// @vitest-environment jsdom
// The comparison tab's typed amount and term must keep what the visitor types
// (see components/website/DraftNumberInput.tsx for the bug this guards).
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/use-live-pricing", () => ({ useLivePricing: () => ({ pricing: {}, loading: false }) }))

import ComparisonTab from "./ComparisonTab"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  env.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<ComparisonTab />) })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete env.IS_REACT_ACT_ENVIRONMENT
})

const [amountField, termField] = [0, 1].map((i) => () => container.querySelectorAll<HTMLInputElement>('input[type="number"]')[i])
const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!

async function input(el: HTMLInputElement, value: string) {
  await act(async () => {
    setNativeValue.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
/** Clears the field, then appends one key at a time, as a person types. */
async function type(el: HTMLInputElement, text: string) {
  await act(async () => { el.focus() })
  await input(el, "")
  for (const key of text) await input(el, el.value + key)
}

describe("comparison tab typed entry", () => {
  it("keeps a typed amount", async () => {
    await type(amountField(), "1500")
    await act(async () => { amountField().blur() })
    expect(amountField().value).toBe("1500")
  })

  it("keeps a typed term", async () => {
    await type(termField(), "45")
    await act(async () => { termField().blur() })
    expect(termField().value).toBe("45")
  })
})
