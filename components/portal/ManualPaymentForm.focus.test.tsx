// @vitest-environment jsdom
// Fair Score acceptance (2026-10-17): the amount (R843.30) and the bank reference
// are pre-filled, so a borrower who clicked in and typed got "843.30843.30". Focus
// selects the whole value, so the first keystroke replaces it.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ManualPaymentForm, type LoanOption } from "./ManualPaymentForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const loans: LoanOption[] = [{ id: "l1", reference: "LN-0001", outstandingPrincipal: 500000, nextInstallment: 84330 }]

let container: HTMLDivElement
let root: Root
let selectSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  selectSpy = vi.spyOn(HTMLInputElement.prototype, "select")
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<ManualPaymentForm loans={loans} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  selectSpy.mockRestore()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function focus(input: HTMLInputElement) {
  await act(async () => input.focus())
}

describe("ManualPaymentForm pre-filled inputs", () => {
  it("selects the whole pre-filled amount on focus", async () => {
    const amount = container.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(amount.value).toBe("843.30")
    await focus(amount)
    expect(selectSpy).toHaveBeenCalledTimes(1)
    expect(selectSpy.mock.contexts[0]).toBe(amount)
  })

  it("selects the whole pre-filled bank reference on focus", async () => {
    const reference = container.querySelector<HTMLInputElement>('input[type="text"]')!
    expect(reference.value).toBe("LN-0001")
    await focus(reference)
    expect(selectSpy).toHaveBeenCalledTimes(1)
    expect(selectSpy.mock.contexts[0]).toBe(reference)
  })
})
