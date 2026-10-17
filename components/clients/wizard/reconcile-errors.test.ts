import { describe, expect, it } from "vitest"
import { reconcileErrors } from "./reconcile-errors"

describe("reconcileErrors", () => {
  // Fair Score audit 2026-10-16: "Not a valid ID" and the DOB "Required"
  // stayed on screen after the ID was corrected, until Next.
  it("drops a message once the edit makes its field valid, including a field the edit filled", () => {
    const shown = { idNumber: "Not a valid 13-digit SA ID number", dateOfBirth: "Required", phone: "Required" }
    const before = { ...shown }
    const after = { phone: "Required" }
    expect(reconcileErrors(shown, before, after, ["idNumber", "dateOfBirth", "gender"])).toEqual({ phone: "Required" })
  })

  it("refreshes a message that is still true", () => {
    expect(reconcileErrors({ idNumber: "Required" }, { idNumber: "Required" }, { idNumber: "Not a valid 13-digit SA ID number" }, ["idNumber"]))
      .toEqual({ idNumber: "Not a valid 13-digit SA ID number" })
  })

  it("never adds a message while typing", () => {
    expect(reconcileErrors({}, {}, { email: "Not a valid email address" }, ["email"])).toEqual({})
  })

  it("keeps a server-only error until its own field is edited", () => {
    const shown = { idNumber: "A client with this ID number already exists" }
    expect(reconcileErrors(shown, {}, {}, ["email"])).toEqual(shown)
    expect(reconcileErrors(shown, {}, {}, ["idNumber"])).toEqual({})
  })
})
