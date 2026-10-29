import { describe, expect, it } from "vitest"
import { parseGroupRoleMap, roleFromGroups } from "./groups"

describe("parseGroupRoleMap", () => {
  it("accepts lender roles", () => {
    expect(parseGroupRoleMap({ "cn=loans": "LOAN_ADMIN", ops: "ADMIN" })).toEqual({ "cn=loans": "LOAN_ADMIN", ops: "ADMIN" })
  })
  it.each(["SUPER_ADMIN", "OPERATOR_ADMIN", "OPERATOR_SUPPORT", "NOPE", 5])("refuses %s", (role) => {
    expect(parseGroupRoleMap({ g: role })).toBeNull()
  })
  it("refuses a non-object", () => {
    expect(parseGroupRoleMap(["ADMIN"])).toBeNull()
    expect(parseGroupRoleMap(null)).toBeNull()
  })
})

describe("roleFromGroups", () => {
  const map = { staff: "READONLY", loans: "LOAN_ADMIN", admins: "ADMIN" } as const
  it("takes the highest-ranked mapped role", () => expect(roleFromGroups(["staff", "admins", "loans"], map)).toBe("ADMIN"))
  it("returns null when no group is mapped", () => expect(roleFromGroups(["other"], map)).toBeNull())
  it("matches exactly, case-sensitively", () => expect(roleFromGroups(["ADMINS"], map)).toBeNull())
  it("never yields a role the map holds outside the lender ceiling", () => {
    expect(roleFromGroups(["g"], { g: "SUPER_ADMIN" } as never)).toBeNull()
  })
})
