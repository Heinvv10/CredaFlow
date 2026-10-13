// @vitest-environment jsdom
// A real DOM so the form is submitted the way a browser submits it and the
// post-sign-in navigation is observed. The callbackUrl comes from the query
// string, which anyone can write into a link: anything but a same-origin path
// would make the sign-in form an open redirect.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { push, signIn, search } = vi.hoisted(() => ({
  push: vi.fn(),
  signIn: vi.fn(),
  search: { value: "" },
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}))
vi.mock("next-auth/react", () => ({ signIn }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))

import LoginForm from "./LoginForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  push.mockReset()
  signIn.mockReset().mockResolvedValue({ ok: true, error: undefined })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

async function signInWith(variant: "staff" | "client", query: string) {
  search.value = query
  await act(async () => root.render(<LoginForm variant={variant} brandName="Synthetic Lender" crossLink={null} />))
  const form = container.querySelector("form")!
  // A submit event, not requestSubmit(): the empty required fields would stop
  // jsdom's constraint validation before the handler runs.
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  expect(signIn).toHaveBeenCalledOnce()
  return push.mock.calls[0]?.[0] as string | undefined
}

describe("LoginForm — where a successful sign-in goes", () => {
  it.each([
    ["a literal backslash", "callbackUrl=" + encodeURIComponent("/\\evil.example")],
    ["a %5C-encoded backslash", "callbackUrl=/%5Cevil.example"],
    ["a double-encoded backslash", "callbackUrl=" + encodeURIComponent("/%5Cevil.example")],
    ["a protocol-relative URL", "callbackUrl=" + encodeURIComponent("//evil")],
    ["an absolute URL", "callbackUrl=" + encodeURIComponent("https://evil")],
  ])("staff: refuses %s and goes to /dashboard", async (_label, query) => {
    expect(await signInWith("staff", query)).toBe("/dashboard")
  })

  it("client: refuses an absolute URL and goes to /portal", async () => {
    expect(await signInWith("client", "callbackUrl=" + encodeURIComponent("https://evil"))).toBe("/portal")
  })

  it.each([
    ["staff", "/loans/123"],
    ["client", "/portal/loans/abc"],
  ] as const)("%s: keeps the internal path %s", async (variant, dest) => {
    expect(await signInWith(variant, "callbackUrl=" + encodeURIComponent(dest))).toBe(dest)
  })
})
