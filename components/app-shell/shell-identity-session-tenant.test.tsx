import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The portal shell, the portal payment-failure page and the staff topbar print
// the lender's identity. They must read it for the SIGNED-IN principal's
// tenant. Three tenants are in play and each has its own identity, so a
// component that read with the request host (getResolvedTenantId) or the
// deployment default (getDefaultTenantId) prints a different lender's name and
// contact details and fails here.

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))

const IDENTITIES: Record<string, { tradingName: string; publicEmail: string; publicPhone: string; publicWhatsappE164: string }> = {
  "tenant-session": { tradingName: "Session Lender", publicEmail: "help@session-lender.test", publicPhone: "011 000 0001", publicWhatsappE164: "+27110000001" },
  "tenant-host": { tradingName: "Host Lender", publicEmail: "help@host-lender.test", publicPhone: "011 000 0002", publicWhatsappE164: "+27110000002" },
  "tenant-default": { tradingName: "Default Lender", publicEmail: "help@default-lender.test", publicPhone: "011 000 0003", publicWhatsappE164: "+27110000003" },
}

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn() } }))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/auth-session", () => ({ getSession: mockGetSession }))
vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: vi.fn(async () => "tenant-host"),
  getDefaultTenantId: vi.fn(async () => "tenant-default"),
}))
vi.mock("@/lib/config/identity", () => ({
  getLenderIdentity: vi.fn(async (tenantId: string) => IDENTITIES[tenantId]),
  getLenderBrandName: vi.fn(async (tenantId: string) => IDENTITIES[tenantId].tradingName),
}))
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: vi.fn(async () => null), publicLenderLogoSrc: vi.fn(async () => null) }))
vi.mock("./PortalSidebar", () => ({
  PortalSidebar: ({ brandName, whatsappE164 }: { brandName: string; whatsappE164: string }) => (
    <aside>{brandName} {whatsappE164}</aside>
  ),
}))
vi.mock("@/components/support/WhatsAppLauncher", () => ({
  WhatsAppLauncher: ({ whatsappE164 }: { whatsappE164: string }) => <div>launcher {whatsappE164}</div>,
}))
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
vi.mock("./NotificationBell", () => ({ NotificationBell: () => null }))

import { PortalShell } from "./PortalShell"
import { AppTopbar } from "./AppTopbar"
import PaymentFailurePage from "@/app/(portal)/portal/payment/failure/page"

function expectOnlySessionLender(html: string) {
  expect(html).toContain("Session Lender")
  for (const other of ["Host Lender", "Default Lender", "host-lender", "default-lender", "+27110000002", "+27110000003"]) {
    expect(html).not.toContain(other)
  }
}

beforeEach(() => mockGetSession.mockReset())

describe("PortalShell", () => {
  it("shows the signed-in client's lender name and WhatsApp, not the host's or the default's", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "c-1", role: "CLIENT", tenantId: "tenant-session" } })
    const html = renderToStaticMarkup(await PortalShell({ userName: "Synthetic Client", userEmail: "c@example.test", children: null }))
    expectOnlySessionLender(html)
    expect(html).toContain("+27110000001")
  })
})

describe("portal payment failure page", () => {
  it("gives the signed-in client's lender email and phone, not the host's or the default's", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "c-1", role: "CLIENT", tenantId: "tenant-session" } })
    const html = renderToStaticMarkup(await PaymentFailurePage())
    expect(html).toContain("help@session-lender.test")
    expect(html).toContain("011 000 0001")
    expect(html).not.toContain("host-lender")
    expect(html).not.toContain("default-lender")
  })
})

describe("AppTopbar", () => {
  it("brands the staff workspace with the staff member's own lender", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u-1", role: "LOAN_ADMIN", tenantId: "tenant-session" } })
    const html = renderToStaticMarkup(await AppTopbar({ user: { name: "Staff Member", email: "s@example.test", role: "LOAN_ADMIN" } }))
    expectOnlySessionLender(html)
  })
})

describe("AppTopbar logo", () => {
  // Fair Score audit 2026-10-16: a dark-blue logo on the near-black header.
  it("sets an uploaded logo on a light, padded chip", async () => {
    const { getLenderLogo } = await import("@/lib/config/lender-logo")
    vi.mocked(getLenderLogo).mockResolvedValueOnce(new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as never)
    mockGetSession.mockResolvedValue({ user: { id: "u-1", role: "LOAN_ADMIN", tenantId: "tenant-session" } })
    const html = renderToStaticMarkup(await AppTopbar({ user: { name: "Staff Member", email: "s@example.test", role: "LOAN_ADMIN" } }))
    expect(html).toMatch(/<span data-logo-chip="true" class="[^"]*bg-white[^"]*px-2\.5[^"]*"><img src="\/api\/settings\/identity\/logo\?v=/)
  })
})
