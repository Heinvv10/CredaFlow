import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ClientsPageClient } from "./ClientsPageClient"
describe("client-list create affordances", () => {
  it("hides both header and empty-state create links for a reader", () => {
    expect(renderToStaticMarkup(<ClientsPageClient clients={[]} canCreate={false} />)).not.toContain("/clients/new")
  })
  it("offers both create entry points to authorized staff", () => {
    expect(renderToStaticMarkup(<ClientsPageClient clients={[]} canCreate />).match(/href="\/clients\/new"/g)).toHaveLength(2)
  })
})
