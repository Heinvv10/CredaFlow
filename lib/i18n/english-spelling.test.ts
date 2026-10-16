import { describe, expect, it } from "vitest"
import { CATALOGS } from "./catalog"

const en = CATALOGS.en as unknown as Record<string, Record<string, string>>

// Borrowers read South African English: "instalment", as the NCA documents print it.
describe("English borrower copy", () => {
  it("spells instalment the South African way", () => {
    const us = Object.entries(en).flatMap(([ns, messages]) =>
      Object.entries(messages).filter(([, text]) => /installment/i.test(text)).map(([key]) => `${ns}.${key}`),
    )
    expect(us).toEqual([])
  })
})
