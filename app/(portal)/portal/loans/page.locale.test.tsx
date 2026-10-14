import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { formatZAR } from "@/lib/utils"
import type { Locale } from "@/lib/i18n/locales"

// The portal loans page rendered in each language: its own copy, the shared
// status labels and the dates follow the locale; money does not.

const { locale, loanFindMany } = vi.hoisted(() => ({ locale: vi.fn<() => Locale>(), loanFindMany: vi.fn() }))
vi.mock("@/lib/i18n/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/server")>()),
  getLocale: async () => locale(),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, loan: { findMany: loanFindMany } },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

import PortalLoansPage from "./page"

beforeEach(() => {
  loanFindMany.mockResolvedValue([{
    id: "l1", reference: "LN-1", status: "ACTIVE", startDate: new Date("2026-10-05T10:00:00Z"),
    outstandingPrincipal: 166_900, totalRepayable: 216_900, nextPaymentDate: new Date("2026-11-01T10:00:00Z"),
    product: { name: "Micro" }, payments: [],
  }])
})

const render = async (l: Locale) => {
  locale.mockReturnValue(l)
  return renderToStaticMarkup(await PortalLoansPage()).replace(/<!-- -->/g, "")
}

describe("portal loans page per locale", () => {
  it.each([
    ["en", "My Loans", "Outstanding", "ACTIVE", "Oct 2026"],
    ["af", "My lenings", "Uitstaande", "AKTIEF", "Okt. 2026"],
    ["zu", "Imalimboleko yami", "Okusele", "IYASEBENZA", "2026"],
    ["xh", "Iimali-mboleko zam", "Eseleyo", "IYASEBENZA", "2026"],
  ] as const)("%s", async (l, title, metric, status, date) => {
    const html = await render(l)
    expect(html).toContain(title)
    expect(html).toContain(metric)
    expect(html).toContain(status)
    expect(html).toContain(date)
    expect(html).toContain(formatZAR(166_900))
    if (l !== "en") {
      expect(html).not.toContain("My Loans")
      expect(html).not.toContain("View Schedule")
    }
  })
})
