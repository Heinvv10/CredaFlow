// @vitest-environment jsdom
// A real DOM so the form is filled and submitted the way a browser does it, and
// the destination handed to router.push is what is read.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { pushMock, refreshMock, signInMock, search } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  signInMock: vi.fn(),
  search: { value: "" },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => new URLSearchParams(search.value),
}))
vi.mock("next-auth/react", () => ({ signIn: signInMock }))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))

import LoginForm, { type LoginVariant } from "./LoginForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  pushMock.mockReset()
  refreshMock.mockReset()
  signInMock.mockReset().mockResolvedValue({ ok: true, error: undefined })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

async function signInAs(variant: LoginVariant, query: string) {
  search.value = query
  await act(async () => root.render(<LoginForm variant={variant} brandName="Acme" crossLink={null} />))
  await act(async () => {
    typeInto(container.querySelector(`#${variant}-login-email`)!, "someone@example.test")
    typeInto(container.querySelector(`#${variant}-login-password`)!, "not-a-real-password")
  })
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

describe("LoginForm post-login redirect", () => {
  it.each([
    ["staff", "callbackUrl=%2Fsettings%2Fusers", "/settings/users"],
    ["client", "callbackUrl=%2Fportal%2Floans%2Fabc", "/portal/loans/abc"],
  ] as const)("%s: follows a same-origin callbackUrl", async (variant, query, expected) => {
    await signInAs(variant, query)
    expect(pushMock).toHaveBeenCalledWith(expected)
  })

  it.each([
    "callbackUrl=%2F%2Fevil.example",
    "callbackUrl=https%3A%2F%2Fevil.example%2Fphish",
    "callbackUrl=%2F%5Cevil.example",
    "callbackUrl=%2F%09%2Fevil.example",
    "callbackUrl=javascript%3Aalert(1)",
  ])("staff: ignores the off-origin %s", async (query) => {
    await signInAs("staff", query)
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith("/dashboard")
  })

  it("client: an off-origin callbackUrl falls back to the portal home", async () => {
    await signInAs("client", "callbackUrl=%2F%2Fevil.example")
    expect(pushMock).toHaveBeenCalledWith("/portal")
  })

  it.each([["staff", "/dashboard"], ["client", "/portal"]] as const)(
    "%s: no callbackUrl goes to the default %s",
    async (variant, fallback) => {
      await signInAs(variant, "")
      expect(pushMock).toHaveBeenCalledWith(fallback)
    },
  )
})
