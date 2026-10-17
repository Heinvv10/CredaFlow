import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ComplianceCapture } from "./ComplianceCapture"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

// Fair Score audit (2026-10-16): a CREDIT_OFFICER could tick the NCA checks and
// then got a raw red "Forbidden" (PATCH /api/applications/[id]/compliance needs
// LOAN_ADMIN). The controls say who can confirm them instead.
const render = (canConfirm: boolean) => renderToStaticMarkup(
  <ComplianceCapture applicationId="app-1" recklessDone={false} affordabilityDeclared={false} canConfirm={canConfirm} />,
)

describe("ComplianceCapture for a role that cannot confirm the NCA checks", () => {
  it("disables every control and names the roles that can", () => {
    const html = render(false)
    const checkboxes = html.match(/<input type="checkbox"[^>]*>/g) ?? []
    expect(checkboxes).toHaveLength(2)
    for (const box of checkboxes) expect(box).toContain('disabled=""')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm Assessment Checks/)
    expect(html).toContain("Needs a Loan Admin, Branch Manager or Admin to confirm these checks.")
    expect(html).not.toContain("Forbidden")
  })

  it("leaves the checks open to a role that can confirm them", () => {
    const html = render(true)
    for (const box of html.match(/<input type="checkbox"[^>]*>/g) ?? []) expect(box).not.toContain('disabled=""')
    expect(html).not.toContain("Needs a Loan Admin")
  })
})
