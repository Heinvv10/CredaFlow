import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { SegregationOfDutiesToggle } from "./SegregationOfDutiesToggle"

const render = (props: Partial<React.ComponentProps<typeof SegregationOfDutiesToggle>>) =>
  renderToStaticMarkup(<SegregationOfDutiesToggle required canChange {...props} />)

describe("SegregationOfDutiesToggle", () => {
  it("shows the current setting on, and lets an admin change it", () => {
    const html = render({})
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/)
    expect(html).not.toMatch(/role="switch"[^>]* disabled=""/)
  })

  it("shows the current setting off", () => {
    expect(render({ required: false })).toMatch(/role="switch"[^>]*aria-checked="false"/)
  })

  it("disables the switch for anyone who cannot change it, and says who can", () => {
    const html = render({ canChange: false })
    expect(html).toMatch(/role="switch"[^>]* disabled=""/)
    expect(html).toContain("Only an Admin or Super Admin can change this.")
  })

  it("names the three pairs it governs", () => {
    const html = render({})
    expect(html).toContain("approving an application and disbursing it")
    expect(html).toContain("in-branch signature and")
    expect(html).toContain("creating an asset-finance payout and approving it")
  })
})
