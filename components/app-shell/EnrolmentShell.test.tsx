import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }))

import { EnrolmentShell } from "./EnrolmentShell"

describe("EnrolmentShell", () => {
  const html = renderToStaticMarkup(<EnrolmentShell><p>enrolment card</p></EnrolmentShell>)

  it("shows the page and a Sign out button", () => {
    expect(html).toContain("enrolment card")
    expect(html).toContain("Sign out")
  })

  it("has no sidebar, navigation or links", () => {
    expect(html).not.toContain("<aside")
    expect(html).not.toContain("<nav")
    expect(html).not.toContain("<a ")
  })
})
