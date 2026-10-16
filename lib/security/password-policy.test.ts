import { describe, expect, it } from "vitest"
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from "./password-policy"

describe("passwordPolicyError", () => {
  it("refuses the audit's password and anything shorter than 10 characters", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10)
    expect(passwordPolicyError("password")).toBe("Use at least 10 characters.")
    expect(passwordPolicyError("Tr0ub4dor")).toBe("Use at least 10 characters.")
  })

  it.each([
    "password12", "Password123!", "P@ssw0rd2026", "qwertyuiop", "qwerty12345", "1234567890", "0987654321",
    "123456789012", "aaaaaaaaaaaa", "abcabcabcabc", "iloveyou123", "welcome2026", "letmein!!!!", "admin12345",
    "1q2w3e4r5t", "springbok1995", "FairScore2026",
  ])("refuses the common or guessable %s", (password) => {
    expect(passwordPolicyError(password)).toBe("That password is too common or too easy to guess. Choose a different one.")
  })

  it.each(["correct horse battery", "Mango-Taxi-Umbrella", "kgotla river 1987 blue", "Lerato's 2nd bakkie!"])(
    "accepts the long, uncommon %s", (password) => {
      expect(passwordPolicyError(password)).toBeNull()
    },
  )

  it("caps the length where bcrypt would silently truncate", () => {
    expect(passwordPolicyError("x".repeat(201))).toBe("Use at most 200 characters.")
  })
})
