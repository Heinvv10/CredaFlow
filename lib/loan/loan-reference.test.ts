import { describe, expect, it, vi } from "vitest"
import { unusedLoanReference } from "./loan-reference"
import { generateReference } from "@/lib/utils"

describe("generateReference", () => {
  it("always ends in 4 random base-36 characters", () => {
    for (let i = 0; i < 500; i++) expect(generateReference("LN")).toMatch(/^LN-[0-9A-Z]+-[0-9A-Z]{4}$/)
  })

  // Math.random() gave "0.i" for 0.5: a 1-character suffix.
  it("draws the suffix from the CSPRNG, never Math.random", () => {
    const math = vi.spyOn(Math, "random").mockReturnValue(0.5)
    const csprng = vi.spyOn(globalThis.crypto, "getRandomValues")
    try {
      expect(generateReference("LN")).toMatch(/-[0-9A-Z]{4}$/)
      expect(csprng).toHaveBeenCalled()
      expect(math).not.toHaveBeenCalled()
    } finally {
      math.mockRestore()
      csprng.mockRestore()
    }
  })
})

describe("unusedLoanReference", () => {
  it("draws again when a reference is already taken", async () => {
    const isTaken = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
    const reference = await unusedLoanReference(isTaken)
    expect(isTaken).toHaveBeenCalledTimes(3)
    expect(reference).toBe(isTaken.mock.calls[2][0])
    expect(reference).toMatch(/^LN-[0-9A-Z]+-[0-9A-Z]{4}$/)
  })

  it("gives up rather than loop forever", async () => {
    await expect(unusedLoanReference(async () => true)).rejects.toThrow(/No unused loan reference/)
  })
})
