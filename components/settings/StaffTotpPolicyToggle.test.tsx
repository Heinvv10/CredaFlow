import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { StaffTotpPolicyToggle } from "./StaffTotpPolicyToggle"

const render = (props: Partial<React.ComponentProps<typeof StaffTotpPolicyToggle>>) =>
  renderToStaticMarkup(<StaffTotpPolicyToggle requireStaffTotp canChange {...props} />)

describe("StaffTotpPolicyToggle", () => {
  it("shows the current setting on, and lets a SUPER_ADMIN change it", () => {
    const html = render({})
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/)
    expect(html).not.toMatch(/role="switch"[^>]* disabled=""/)
  })

  it("shows the current setting off", () => {
    expect(render({ requireStaffTotp: false })).toMatch(/role="switch"[^>]*aria-checked="false"/)
  })

  it("disables the switch for anyone who cannot change it, and says who can", () => {
    const html = render({ canChange: false })
    expect(html).toMatch(/role="switch"[^>]* disabled=""/)
    expect(html).toContain("Only a Super Admin can change this.")
  })
})
