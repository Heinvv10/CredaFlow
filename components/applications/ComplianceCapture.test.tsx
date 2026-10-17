import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ComplianceCapture } from "./ComplianceCapture"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

// Fair Score audit (2026-10-16): a CREDIT_OFFICER could tick the NCA checks and
// then got a raw red "Forbidden" (PATCH /api/applications/[id]/compliance needs
// LOAN_ADMIN). The controls say who can confirm them instead.
const render = (canConfirm: boolean, recklessDone = false) => renderToStaticMarkup(
  <ComplianceCapture applicationId="app-1" recklessDone={recklessDone} affordabilityDeclared={false} canConfirm={canConfirm} />,
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

// Fair Score acceptance (2026-10-17): ticking "Reckless lending assessment completed"
// mounted the notes textarea inside its label, pushing the affordability checkbox
// down ~61px so the next click hit the wrong control.
describe("ComplianceCapture layout stability", () => {
  const textarea = (html: string) => html.match(/<textarea[^>]*>/)?.[0]
  const tick = (html: string) => html.match(/<svg[^>]*lucide-circle-check[^>]*>/g) ?? []

  it("renders the notes textarea whether or not the reckless box is ticked", () => {
    expect(textarea(render(true, false))).toBeDefined()
    expect(textarea(render(true, true))).toBeDefined()
  })

  it("keeps the textarea disabled until the box is ticked, and disabled for a role that cannot confirm", () => {
    expect(textarea(render(true, false))).toContain('disabled=""')
    expect(textarea(render(true, true))).not.toContain('disabled=""')
    expect(textarea(render(false, true))).toContain('disabled=""')
  })

  it("keeps the textarea outside the label so a click in it cannot toggle the checkbox", () => {
    const html = render(true, true)
    const labelOpen = html.indexOf("<label")
    const labelClose = html.indexOf("</label>")
    const area = html.indexOf("<textarea")
    expect(area).toBeGreaterThan(labelClose)
    expect(labelOpen).toBeLessThan(labelClose)
  })

  it("keeps the tick icon mounted (invisible) when unticked so row widths do not change", () => {
    const unticked = render(true, false)
    expect(tick(unticked).length).toBeGreaterThanOrEqual(2)
    for (const icon of tick(unticked)) expect(icon).toContain("invisible")
    expect(tick(render(true, true)).some(icon => !icon.includes("invisible"))).toBe(true)
  })
})
