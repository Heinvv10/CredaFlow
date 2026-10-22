import { describe, expect, it } from "vitest"
import { dealerNameProblem, dealerPrintRefusal, documentDealer, MAX_DEALER_NAME } from "./dealer-name"

describe("dealerNameProblem: the shape of a name printed in a labelled field", () => {
  it.each([
    "Highveld Yellow Iron (Pty) Ltd", "Karoo Asset Brokers CC", "O'Brien & Sons", "Smith, Jones and Partners", "4 Wheel Drive Centre",
    "Schön Motors", "Jan-Pieter Trucks", "May & Sons", "Price Brothers Plant Hire", "Not Just Tractors", "Zero Fee Motors",
    "Karoo Plant Hire Pty. Ltd.", 'Smith "Quick" Motors', "A".repeat(MAX_DEALER_NAME),
  ])("accepts %j", (name) => {
    expect(dealerNameProblem(name)).toBeNull()
  })

  it.each([
    ["an empty name", ""],
    ["only spaces", "   "],
    ["a leading space", " Motors"],
    ["a trailing space", "Motors "],
    ["a double space", "X  Motors"],
    ["more than the maximum", "A".repeat(MAX_DEALER_NAME + 1)],
    ["a line break", "X\nThe Purchaser waives"],
    ["a carriage return", "X\rMotors"],
    ["a tab", "X\tMotors"],
    ["a control character", "X\u0007Motors"],
    ["a C1 control character", "X\u0085Motors"],
    ["a no-break space", "X Motors"],
    ["a soft hyphen", "Mo­tors"],
    ["a zero-width space", "Mo​tors"],
    ["a zero-width joiner", "Mo‍tors"],
    ["a word joiner", "Mo⁠tors"],
    ["a byte-order mark", "Mo﻿tors"],
    ["a right-to-left override", "Mo‮tors"],
    ["a line separator", "X Motors"],
    ["a character the document font cannot print", "X 中文 Motors"],
    ["an emoji", "X 😀 Motors"],
  ])("refuses %s", (_, name) => {
    expect(dealerNameProblem(name)).toEqual(expect.any(String))
  })
})

describe("dealerPrintRefusal and documentDealer", () => {
  it("names the document, not an agreement, and quotes the name escaped", () => {
    const refusal = dealerPrintRefusal("Mo­tors")
    expect(refusal).toMatch(/cannot be printed on the document/)
    expect(refusal).not.toMatch(/agreement/i)
    expect(refusal).toContain("Mo\\u00adtors")
    expect(dealerPrintRefusal("Highveld Yellow Iron (Pty) Ltd")).toBeNull()
  })

  it("maps a stored dealer to the document's dealer, or none", () => {
    expect(documentDealer(null)).toBeNull()
    expect(documentDealer(undefined)).toBeNull()
    expect(documentDealer({ name: "Karoo", kind: "BROKER", contactEmail: "x@y.invalid" } as { name: string; kind: "BROKER" })).toEqual({ name: "Karoo", kind: "BROKER" })
  })
})
