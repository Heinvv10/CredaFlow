import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createTranslator, interpolate } from "./translate"
import { richText } from "./rich"

describe("createTranslator", () => {
  it("reads the locale's catalogue", () => {
    expect(createTranslator("en", "portalShell")("signOut")).toBe("Sign out")
    expect(createTranslator("af", "portalShell")("signOut")).toBe("Teken uit")
    expect(createTranslator("zu", "portalShell")("signOut")).toBe("Phuma")
    expect(createTranslator("xh", "portalShell")("navSupport")).toBe("Uncedo")
  })

  it("fills placeholders", () => {
    expect(createTranslator("af", "portalShell")("hi", { name: "Thandi" })).toBe("Hallo Thandi")
  })

  it("is type-checked against the English catalogue", () => {
    const t = createTranslator("en", "portalShell")
    // @ts-expect-error — not a key of portalShell
    expect(() => t("noSuchKey")).toThrow()
    // @ts-expect-error — "hi" needs { name }
    expect(() => t("hi")).toThrow('missing value for placeholder "{name}"')
  })
})

describe("interpolate", () => {
  it("throws rather than print a raw placeholder", () => {
    expect(() => interpolate("Pay {amount}", {})).toThrow()
    expect(interpolate("Pay {amount} by {date}", { amount: "R 5.00", date: 3 })).toBe("Pay R 5.00 by 3")
  })
})

describe("richText", () => {
  it("renders only the given tags, as text nodes", () => {
    const html = renderToStaticMarkup(
      <p>{richText("Pay <b>R 5.00</b> now <i>x</i> <b><script></b>", { b: (c) => <strong>{c}</strong> })}</p>,
    )
    expect(html).toBe("<p>Pay <strong>R 5.00</strong> now &lt;i&gt;x&lt;/i&gt; <strong>&lt;script&gt;</strong></p>")
  })
})
