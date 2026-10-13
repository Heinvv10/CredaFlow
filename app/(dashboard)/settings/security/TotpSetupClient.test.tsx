import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }))

import { TotpSetupClient } from "./TotpSetupClient"

const render = (props: Partial<React.ComponentProps<typeof TotpSetupClient>>) =>
  renderToStaticMarkup(<TotpSetupClient email="officer@lender.example" totpEnabled={false} required={false} enrolmentForced={false} {...props} />)

describe("TotpSetupClient", () => {
  it("offers to turn 2FA off when it is on and the lender does not require it", () => {
    expect(render({ totpEnabled: true })).toContain("Disable 2FA")
  })

  it("offers no way to turn 2FA off while the lender requires it, and says why", () => {
    const html = render({ totpEnabled: true, required: true })
    expect(html).not.toContain("Disable 2FA")
    expect(html).toContain("Your organisation requires two-factor authentication")
  })

  it("tells a user held at enrolment what is needed, and offers to enable 2FA", () => {
    const html = render({ required: true, enrolmentForced: true })
    expect(html).toContain("Set it up to continue")
    expect(html).toContain("Enable 2FA")
  })

  it("shows no such notice to a user who is not held at enrolment", () => {
    expect(render({})).not.toContain("Set it up to continue")
    expect(render({ totpEnabled: true })).not.toContain("Your organisation requires")
  })
})
