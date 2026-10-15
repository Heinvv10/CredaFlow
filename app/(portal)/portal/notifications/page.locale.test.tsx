import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Locale } from "@/lib/i18n/locales"

// Portal notification labels follow the locale, except Section 129: an NCA
// notice, labelled in English in every language.

const h = vi.hoisted(() => ({ locale: vi.fn<() => Locale>(), findMany: vi.fn(), items: [] as Array<{ event: string; eventLabel: string }> }))
vi.mock("@/lib/i18n/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n/server")>()),
  getLocale: async () => h.locale(),
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { email: "t@example.test" } })) }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: vi.fn(async () => "t1") }))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findFirst: vi.fn(async () => ({ id: "c1" })) }, notificationLog: { findMany: h.findMany } },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("./NotificationTabs", () => ({
  NotificationTabs: ({ items }: { items: Array<{ event: string; eventLabel: string }> }) => {
    h.items = items
    return null
  },
}))

import NotificationsPage from "./page"

const row = (id: string, event: string) =>
  ({ id, event, channel: "email", status: "sent", error: null, createdAt: new Date("2026-10-05T10:00:00Z") })

beforeEach(() => {
  h.findMany.mockResolvedValue([row("n1", "PAYMENT_RECEIVED"), row("n2", "SECTION_129_NOTICE"), row("n3", "section129_sent")])
})

const labels = async (l: Locale) => {
  h.locale.mockReturnValue(l)
  renderToStaticMarkup(await NotificationsPage())
  return Object.fromEntries(h.items.map((i) => [i.event, i.eventLabel]))
}

describe("portal notification labels per locale", () => {
  it.each([
    ["en", "Payment received"],
    ["af", "Betaling ontvang"],
  ] as const)("%s translates ordinary events", async (l, received) => {
    expect((await labels(l)).PAYMENT_RECEIVED).toBe(received)
  })

  it.each(["en", "af", "zu", "xh"] as const)("%s keeps the Section 129 labels English", async (l) => {
    const got = await labels(l)
    expect(got.SECTION_129_NOTICE).toBe("Section 129 notice")
    expect(got.section129_sent).toBe("section129 sent")
  })
})
