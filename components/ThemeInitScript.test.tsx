import { afterEach, describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { THEME_INIT_SCRIPT } from "@/lib/theme"
import { ThemeInitScript } from "./ThemeInitScript"

// The theme init script is server HTML only: a client render of the root
// layout (a notFound() response does one) must not create an inline <script>,
// which React warns about in the browser console and never runs.
const g = globalThis as { window?: unknown }

afterEach(() => { delete g.window })

describe("ThemeInitScript", () => {
  it("renders the init script on the server", () => {
    expect(renderToStaticMarkup(<ThemeInitScript />)).toBe(`<script>${THEME_INIT_SCRIPT}</script>`)
  })

  it("renders nothing in the browser", () => {
    g.window = {}
    expect(ThemeInitScript()).toBeNull()
  })
})
