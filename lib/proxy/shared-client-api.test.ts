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

  // A key-facts application's loan documents: the borrower acknowledges and signs (POST), and reads the state (GET);
  // issuing them (POST on the base path) is staff-only.
  it.each(["/api/applications/app-1/non-nca-documents/acknowledge", "/api/applications/app-1/non-nca-documents/sign"])("allows %s for POST only", (pathname) => {
    for (const method of METHODS) expect(isSharedClientApiPath(pathname, method), method).toBe(method === "POST")
  })

  it("allows the loan documents state for GET only; issuing them stays staff-only", () => {
    const pathname = "/api/applications/app-1/non-nca-documents"
    for (const method of METHODS) expect(isSharedClientApiPath(pathname, method), method).toBe(method === "GET")
  })

  // The signing one-time code: the borrower requests and verifies it on the
  // portal host; both endpoints are POST-only.
  it.each(["/api/signing-otp", "/api/signing-otp/otp-1/verify"])("allows %s for POST only", (pathname) => {
    for (const method of METHODS) {
      expect(isSharedClientApiPath(pathname, method), method).toBe(method === "POST")
    }
  })

  it.each(["/api/signing-otp/otp-1", "/api/signing-otp/otp-1/verify/x", "/api/signing-otpx"])(
    "does not widen to %s",
    (pathname) => {
      for (const method of METHODS) expect(isSharedClientApiPath(pathname, method), method).toBe(false)
    },
  )

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
