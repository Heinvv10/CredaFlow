import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("reference=APP-1"),
}))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
vi.mock("@/components/turnstile-widget", () => ({ TurnstileWidget: () => null }))
vi.mock("@/lib/analytics/events", () => ({
  trackRegisterActivated: vi.fn(),
  trackRegisterCodeSent: vi.fn(),
  trackRegisterStart: vi.fn(),
}))

import PortalRegisterForm from "./PortalRegisterForm"

describe("PortalRegisterForm — brand tokens", () => {
  const html = renderToStaticMarkup(<PortalRegisterForm />)

  it("styles the primary button and the reference banner from the tenant brand tokens", () => {
    expect(html).toContain("bg-[var(--cf-brand)]")
    expect(html).toContain("Application reference")
  })

  it("carries no fixed brand colour that ignores the tenant theme", () => {
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).not.toMatch(/\b(indigo|blue|violet|purple)-\d/)
    expect(html).not.toContain("79,70,229")
  })
})

describe("PortalRegisterForm — states not in the first render", () => {
  it("source has no fixed indigo rgba or Tailwind red/green status tints", () => {
    const src = readFileSync(join(__dirname, "PortalRegisterForm.tsx"), "utf8")
    expect(src).not.toContain("79,70,229")
    expect(src).not.toMatch(/(red|indigo|blue)-\d{3}/)
  })
})
