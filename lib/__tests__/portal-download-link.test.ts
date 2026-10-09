import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const portalPage = readFileSync("app/(portal)/portal/page.tsx", "utf8")

describe("portal download actions", () => {
  it("renders API downloads as anchors so Next Link does not prefetch PDFs as RSC", () => {
    expect(portalPage).toContain('const isDownload = action.href.startsWith("/api/")')
    expect(portalPage).toContain("isDownload || isExternal ? (")
    expect(portalPage).toContain("<a href={action.href}")
    expect(portalPage).toContain("<Link href={action.href}>{content}</Link>")
  })
})
