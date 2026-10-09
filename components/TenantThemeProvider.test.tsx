import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TenantThemeProvider } from "./TenantThemeProvider"

const render = (config: Parameters<typeof TenantThemeProvider>[0]["config"]) =>
  renderToStaticMarkup(<TenantThemeProvider config={config}><p>page</p></TenantThemeProvider>)

describe("TenantThemeProvider", () => {
  it("publishes the tenant's colours as the --cf-tenant-* variables globals.css builds the brand from", () => {
    const html = render({ primaryColor: "#123456", secondaryColor: "#ABCDEF", darkColor: "#0A0B0C" })
    expect(html).toContain(":root{--cf-tenant-primary:#123456;--cf-tenant-secondary:#ABCDEF;--cf-tenant-dark:#0A0B0C;}")
    expect(html).toContain("<p>page</p>")
  })

  it("drops anything that is not #rrggbb, so a stored value cannot inject CSS", () => {
    const html = render({ primaryColor: "red;}body{display:none", secondaryColor: "#abc", darkColor: "#0a0b0c" })
    expect(html).not.toContain("display:none")
    expect(html).not.toContain("--cf-tenant-primary")
    expect(html).not.toContain("--cf-tenant-secondary")
    expect(html).toContain("--cf-tenant-dark:#0a0b0c;")
  })

  it("without a config the globals.css defaults apply", () => {
    expect(render(null)).toBe("<p>page</p>")
  })
})
