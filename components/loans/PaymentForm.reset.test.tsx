// @vitest-environment jsdom
// A real DOM so the form is typed into and submitted the way staff do it.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }))
vi.mock("@/lib/toast", () => ({
  toast: { payment: { recorded: vi.fn(), recordedWithRefund: vi.fn(), recordedFullyUnapplied: vi.fn(), failed: vi.fn() } },
}))

import { PaymentForm } from "./PaymentForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(
    <PaymentForm loanId="loan-1" settlementAmount={400_000} contractualBalance={500_000}
      loanStartDay="2026-04-17" canAuthoriseBackdate={false} />,
  ))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!
}

// React tracks a controlled input's value; set it through the native setter so onChange fires.
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

describe("PaymentForm after a recorded payment", () => {
  it("clears the amount, reference and notes so the same receipt is not captured twice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, refundDueAmount: 0 })))
    await act(async () => {
      type(field("amount"), "843.30")
      type(field("reference"), "EFT ELIZE SEP")
      type(field("notes"), "Paid at branch")
    })

    await submit()

    expect(refreshMock).toHaveBeenCalled()
    expect(field("amount").value).toBe("")
    expect(field("reference").value).toBe("")
    expect(field("notes").value).toBe("")
  })

  it("keeps what was typed when the payment is refused, so staff can correct it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Loan is not active" }, { status: 409 })))
    await act(async () => {
      type(field("amount"), "843.30")
      type(field("reference"), "EFT ELIZE SEP")
    })

    await submit()

    expect(field("reference").value).toBe("EFT ELIZE SEP")
    expect(container.textContent).toContain("Loan is not active")
  })
})
