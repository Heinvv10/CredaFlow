import { describe, expect, it } from "vitest"
import {
  isReadMethod,
  operatorWriteRefusal,
  REQUEST_ID_HEADER,
  REQUEST_METHOD_HEADER,
  stampRequest,
} from "./operator-read-only"

describe("operatorWriteRefusal — support access is read-only at the edge", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses an operator %s to an API route", async (method) => {
    const res = operatorWriteRefusal("OPERATOR_SUPPORT", method, "/api/clients/c1/messages")
    expect(res?.status).toBe(403)
  })

  it("refuses an operator's server action (a POST to a page path)", () => {
    expect(operatorWriteRefusal("OPERATOR_ADMIN", "POST", "/clients/c1")?.status).toBe(403)
  })

  it("lets an operator read, and sign out", () => {
    expect(operatorWriteRefusal("OPERATOR_SUPPORT", "GET", "/api/clients/c1")).toBeNull()
    expect(operatorWriteRefusal("OPERATOR_SUPPORT", "HEAD", "/clients")).toBeNull()
    expect(operatorWriteRefusal("OPERATOR_SUPPORT", "POST", "/api/auth/signout")).toBeNull()
  })

  it("leaves lender staff and clients alone", () => {
    expect(operatorWriteRefusal("ADMIN", "POST", "/api/clients")).toBeNull()
    expect(operatorWriteRefusal("CLIENT", "POST", "/api/portal/payment/initiate")).toBeNull()
    expect(operatorWriteRefusal(undefined, "POST", "/api/website/apply")).toBeNull()
  })
})

describe("stampRequest", () => {
  it("replaces a caller-supplied method and id with the edge's own", () => {
    const h = stampRequest(new Headers({ [REQUEST_METHOD_HEADER]: "GET", [REQUEST_ID_HEADER]: "forged" }), "post", "/api/x")
    expect(h.get(REQUEST_METHOD_HEADER)).toBe("POST")
    expect(h.get(REQUEST_ID_HEADER)).not.toBe("forged")
    expect(h.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("isReadMethod", () => {
  it("treats a missing method as a write", () => {
    expect(isReadMethod(null)).toBe(false)
    expect(isReadMethod(undefined)).toBe(false)
    expect(isReadMethod("get")).toBe(true)
  })
})
