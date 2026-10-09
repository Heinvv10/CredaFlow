import { describe, expect, it } from "vitest"
import { safeErrorInfo } from "./http"

describe("safeErrorInfo", () => {
  it("omits the message for Prisma errors (it embeds query arguments)", () => {
    const err = Object.assign(new Error("Argument name: Thandi, phone: 27821234567"), { name: "PrismaClientValidationError", code: "P2002" })
    const info = safeErrorInfo(err)
    expect(info).toEqual({ name: "PrismaClientValidationError", code: "P2002" })
    expect(JSON.stringify(info)).not.toContain("27821234567")
  })
  it("keeps the message for a plain Error", () => {
    expect(safeErrorInfo(new Error("boom"))).toEqual({ message: "boom" })
  })
  it("keeps the code when present on a plain Error", () => {
    expect(safeErrorInfo(Object.assign(new Error("boom"), { code: "E1" }))).toEqual({ message: "boom", code: "E1" })
  })
  it("stringifies a non-Error", () => {
    expect(safeErrorInfo("oops")).toEqual({ message: "oops" })
    expect(safeErrorInfo(null)).toEqual({ message: "null" })
  })
})
