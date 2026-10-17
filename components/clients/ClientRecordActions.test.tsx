import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ClientRecordActions } from "./ClientRecordActions"
describe("client action permissions", () => {
  it.each(["READONLY", "INSURANCE_OFFICER", "COLLECTIONS_AGENT", null] as const)("offers no write actions to %s", role => {
    expect(renderToStaticMarkup(<ClientRecordActions role={role} clientId="synthetic" />)).toBe("")
  })
  it.each(["CREDIT_OFFICER", "LOAN_ADMIN", "ADMIN"] as const)("offers the server-authorized actions to %s", role => {
    const html = renderToStaticMarkup(<ClientRecordActions role={role} clientId="synthetic" />)
    expect(html).toContain("/clients/synthetic/edit")
    expect(html).toContain("/applications/new?clientId=synthetic")
  })
})
