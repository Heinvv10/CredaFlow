// @vitest-environment jsdom
// The demo code shown on the two portal code-entry screens: the parse, the
// notice, and both forms end to end with a stubbed fetch — including that a
// code shown for one request is cleared when a later request returns none.
import { act, useEffect, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/lib/analytics/events", () => ({
  trackRegisterStart: vi.fn(),
  trackRegisterCodeSent: vi.fn(),
  trackRegisterActivated: vi.fn(),
}))
// Solves the challenge as soon as it mounts, as a passing Turnstile would.
vi.mock("@/components/turnstile-widget", () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) => {
    useEffect(() => onToken("solved-token"), [onToken])
    return null
  },
}))

import { DemoCodeNotice, demoCodeFrom } from "./DemoCodeNotice"
import PortalForgotPasswordForm from "@/components/auth/PortalForgotPasswordForm"
import PortalRegisterForm from "@/app/portal/register/PortalRegisterForm"

describe("demoCodeFrom", () => {
  it("returns the code a demo response carries", () => {
    expect(demoCodeFrom({ success: true, demoCode: "123456" })).toBe("123456")
  })
  it.each([
    ["no code", { success: true }],
    ["a non-string code", { success: true, demoCode: 123456 }],
    ["a null body", null],
    ["a non-object body", "ok"],
  ])("returns an empty string for %s", (_label, body) => {
    expect(demoCodeFrom(body)).toBe("")
  })
})

describe("DemoCodeNotice", () => {
  it("shows the code", () => {
    const html = renderToStaticMarkup(<DemoCodeNotice code="123456" />)
    expect(html).toContain("Demo environment: your code is")
    expect(html).toContain("123456")
  })
})

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

function stubResponses(...bodies: object[]) {
  const fetchMock = vi.fn(async () => Response.json(bodies.shift()))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// Bypasses constraint validation (the inputs are empty): what is under test is
// the response handling, not the browser's required-field check.
async function submitFirstForm() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

async function clickButton(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label))
  if (!button) throw new Error(`no button "${label}"`)
  await act(async () => button.click())
}

function shownCode(): string | null {
  return container.querySelector("[data-demo-code] strong")?.textContent ?? null
}

describe.each([
  ["PortalForgotPasswordForm", () => <PortalForgotPasswordForm brandName="Acme Lending" />, "Start over"],
  ["PortalRegisterForm", () => <PortalRegisterForm />, "Back to edit details"],
])("%s", (_name, render, backLabel) => {
  beforeEach(async () => {
    await act(async () => root.render(render()))
  })

  it("shows the code a demo response returns", async () => {
    stubResponses({ success: true, demoCode: "111111" })
    await submitFirstForm()
    expect(shownCode()).toBe("111111")
  })

  it("shows no notice when the response carries no code", async () => {
    const fetchMock = stubResponses({ success: true })
    await submitFirstForm()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(backLabel)
    expect(container.querySelector("[data-demo-code]")).toBeNull()
  })

  it("clears a code shown earlier when a later request returns none", async () => {
    const fetchMock = stubResponses({ success: true, demoCode: "111111" }, { success: true })
    await submitFirstForm()
    expect(shownCode()).toBe("111111")

    await clickButton(backLabel)
    await submitFirstForm()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(container.querySelector("[data-demo-code]")).toBeNull()
  })
})
