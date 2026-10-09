import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ChargesBreakdown } from "./ChargesBreakdown"

describe("ChargesBreakdown", () => {
  it("says plainly which default charges an amount includes", () => {
    const html = renderToStaticMarkup(<ChargesBreakdown lines={[
      { label: "Default interest", amount: 3_000 },
      { label: "Collection letter fee", amount: 8_200 },
    ]} />)
    expect(html).toContain("Includes")
    expect(html).toContain("Default interest R 30.00")
    expect(html).toContain("Collection letter fee R 82.00")
  })

  it("renders nothing when no charges are owed", () => {
    expect(renderToStaticMarkup(<ChargesBreakdown lines={[]} />)).toBe("")
  })
})
