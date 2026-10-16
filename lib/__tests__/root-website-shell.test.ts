import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("root website shell", () => {
  // `/` sits outside the (website) route group, so it must use the same shell
  // the group's layout does, or it loses the nav, footer and support widget.
  it("renders / and the (website) pages through the one website shell", () => {
    expect(readFileSync(join(process.cwd(), "app/page.tsx"), "utf8")).toContain("<WebsiteShell")
    expect(readFileSync(join(process.cwd(), "app/(website)/layout.tsx"), "utf8")).toContain("<WebsiteShell")
  })

  it("the shell mounts analytics, nav, footer and the support widget with the AI chat, not the bare WhatsApp launcher", () => {
    const source = readFileSync(join(process.cwd(), "components/website/WebsiteShell.tsx"), "utf8")

    expect(source).toContain("@/components/website/NavBar")
    expect(source).toContain("@/components/website/Footer")
    expect(source).toContain("@/components/analytics/WebsiteAnalytics")
    expect(source).toContain("<WebsiteAnalytics />")
    expect(source).toContain("<NavBar enabledLocales={enabledLocales} logoSrc={logoSrc} />")
    expect(source).toContain("<Footer identity={identity} locale={locale} />")
    expect(source).toContain("<WebsiteSupport whatsappE164=")
    expect(source).not.toContain("<WhatsAppLauncher")
  })

  /* The footer's `relative z-10` is load-bearing, and nothing about it looks
     it — a tidy-up would remove it as a stray utility class.

     The insurance quotes page renders a `position: fixed` photographic field.
     A positioned layer paints above non-positioned content regardless of
     document order, so without this class the whole footer disappears behind
     it: measured 6.99:1 -> 1.05:1 on the "Registered Credit Provider —
     NCR · FSP" strip, unreadable while still clickable.

     A comment saying so is not a control. This is. */
  it("keeps the footer above any page-level fixed background layer", () => {
    const source = readFileSync(join(process.cwd(), "components/website/Footer.tsx"), "utf8")
    expect(source).toMatch(/<footer className="[^"]*\brelative\b[^"]*\bz-10\b/)
  })
})
