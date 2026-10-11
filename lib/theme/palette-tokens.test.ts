import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { surfaces } from "./contrast"
import { PALETTE_SURFACES } from "./palette-tokens"

const fromCss = (css: string) =>
  Object.fromEntries(
    Object.entries(surfaces(css)).map(([name, tokens]) => [
      name,
      Object.fromEntries(Object.entries(tokens).filter(([k]) => k.startsWith("--cf-"))),
    ]),
  )

describe("PALETTE_SURFACES", () => {
  it("is exactly the --cf-* tokens app/globals.css defines", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8")
    expect(PALETTE_SURFACES).toEqual(fromCss(css))
  })
})
