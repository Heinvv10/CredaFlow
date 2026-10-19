import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const headerValues = vi.hoisted(() => ({ host: "" }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: headerValues.host }),
}))

import NotFound from "./not-found"

async function render(host: string): Promise<string> {
  headerValues.host = host
  return renderToStaticMarkup(await NotFound())
}

describe("root 404 is host-aware", () => {
  beforeEach(() => {
    vi.stubEnv("STAFF_APP_HOST", "staff.lender.example")
  })

  it("serves the staff host a dashboard link and no public apply links", async () => {
    const html = await render("staff.lender.example")
    expect(html).toContain('href="/dashboard"')
    expect(html).not.toContain("Apply online")
    expect(html).not.toContain("Check if I qualify")
    expect(html).not.toContain("/site/apply")
  })

  it("ignores the port when matching the staff host", async () => {
    expect(await render("staff.lender.example:3000")).not.toContain("Apply online")
  })

  it("keeps the public links on any other host", async () => {
    const html = await render("www.lender.example")
    expect(html).toContain("Apply online")
    expect(html).toContain("Check if I qualify")
  })

  it("keeps the public links when no staff host is configured", async () => {
    vi.stubEnv("STAFF_APP_HOST", "")
    expect(await render("staff.lender.example")).toContain("Apply online")
  })
})
