import { hostname, userInfo } from "node:os"
import { describe, expect, it } from "vitest"
import { operatorId } from "./operator"

describe("operatorId", () => {
  it("prefers the operator the wrapper passed in", () => {
    expect(operatorId({ LENDER_OPERATOR: " alice@vps-1 " })).toBe("alice@vps-1")
  })

  it("falls back to this process's user and host", () => {
    expect(operatorId({})).toBe(`${userInfo().username}@${hostname()}`)
    expect(operatorId({ LENDER_OPERATOR: "  " })).toBe(`${userInfo().username}@${hostname()}`)
  })
})
