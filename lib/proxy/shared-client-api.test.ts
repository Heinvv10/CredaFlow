import { describe, expect, it } from "vitest"
import { isSharedClientApiPath } from "./shared-client-api"

describe("shared client API audience matcher", () => {
  it.each([
    "/api/applications/app-1/pasq",
    "/api/applications/app-1/pasq/acknowledge",
    "/api/applications/app-1/agreement",
    "/api/applications/app-1/agreement/sign",
    "/api/applications/app-1/debit-mandate",
    "/api/applications/app-1/debit-mandate/sign",
    "/api/documents",
    "/api/documents/doc-1/view",
    "/api/clients/client-1/documents",
    "/api/loans/loan-1/statement",
  ])("allows the client portal route %s", (pathname) => {
    expect(isSharedClientApiPath(pathname)).toBe(true)
  })

  it.each([
    "/api/applications/app-1/decide",
    "/api/applications/app-1/pasq/admin",
    "/api/applications/app-1/agreement/countersign",
    "/api/clients/client-1/documents/doc-1/verify",
    "/api/documents/doc-1/extract",
  ])("keeps the staff-only route %s out of the shared audience", (pathname) => {
    expect(isSharedClientApiPath(pathname)).toBe(false)
  })
})
