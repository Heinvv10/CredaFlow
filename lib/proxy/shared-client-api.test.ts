import { describe, expect, it } from "vitest"
import { isSharedClientApiPath } from "./shared-client-api"

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

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
  ])("allows the client portal route %s, whatever the method", (pathname) => {
    for (const method of METHODS) expect(isSharedClientApiPath(pathname, method), method).toBe(true)
  })

  // The borrower only reads the packet. Its POST records a returned signed
  // packet and is staff-only; HEAD would run the GET handler and log a read
  // that served nothing.
  it("allows the signing packet for GET only", () => {
    const pathname = "/api/applications/app-1/signing-packet"
    for (const method of METHODS) {
      expect(isSharedClientApiPath(pathname, method), method).toBe(method === "GET")
    }
  })

  it.each([
    "/api/applications/app-1/decide",
    "/api/applications/app-1/pasq/admin",
    "/api/applications/app-1/agreement/countersign",
    "/api/applications/app-1/signing-packet/email",
    "/api/applications/app-1/signing-packets",
    "/api/applications/app-1/decide/signing-packet",
    "/api/clients/client-1/signing-packets",
    "/api/clients/client-1/documents/doc-1/verify",
    "/api/documents/doc-1/extract",
  ])("keeps the staff-only route %s out of the shared audience", (pathname) => {
    for (const method of METHODS) expect(isSharedClientApiPath(pathname, method), method).toBe(false)
  })
})
