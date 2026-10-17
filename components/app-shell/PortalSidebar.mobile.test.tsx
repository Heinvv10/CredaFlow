// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PortalSidebar } from "./PortalSidebar"
import { buildPortalNavigation } from "@/lib/navigation"
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }))
vi.mock("next/navigation", () => ({ usePathname: () => "/portal" }))
vi.mock("next-auth/react", () => ({ signOut }))
vi.mock("next/link", () => ({ default: ({ onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} onClick={event => { event.preventDefault(); onClick?.(event) }} /> }))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
const props = { userName: "Test Synthetic", userEmail: "test@example.test", brandName: "Synthetic", whatsappE164: null }
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div"); document.body.append(container); root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete environment.IS_REACT_ACT_ENVIRONMENT })
async function open(showBusiness = false) {
  await act(async () => root.render(<PortalSidebar {...props} showBusiness={showBusiness} />))
  const triggers = document.querySelectorAll<HTMLButtonElement>('button[aria-label="Menu"]')
  expect(triggers).toHaveLength(1)
  expect(document.querySelector("details")).toBeNull()
  await act(async () => triggers[0].click())
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  return dialog
}
describe("mobile portal Dialog menu", () => {
  it.each([false, true])("offers every allowed destination and sign-out (business=%s)", async showBusiness => {
    const dialog = await open(showBusiness)
    const links = [...dialog.querySelectorAll("nav a")].map(a => a.getAttribute("href"))
    for (const item of buildPortalNavigation(null, { business: showBusiness })) expect(links).toContain(item.href)
    expect(links.includes("/portal/business")).toBe(showBusiness)
    expect(dialog.textContent).toContain("Sign out")
    expect(dialog.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("/portal")
  })
  it("closes the Dialog when selecting a destination", async () => {
    const dialog = await open()
    await act(async () => dialog.querySelector<HTMLAnchorElement>('a[href="/portal/loans"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
  it("signs the mobile client out using the portal return route", async () => {
    const dialog = await open()
    const button = [...dialog.querySelectorAll("button")].find(b => b.textContent?.trim() === "Sign out")!
    await act(async () => button.click())
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/portal/login" })
  })
})
