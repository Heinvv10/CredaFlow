import { describe, expect, it } from "vitest"
import { dealerNameProblem } from "./dealer-name"

describe("dealerNameProblem: a name safe to print inside the protected commission paragraph", () => {
  it.each([
    "Highveld Yellow Iron (Pty) Ltd", "Karoo Asset Brokers CC", "O'Brien & Sons", "Smith, Jones and Partners", "4 Wheel Drive Centre",
    "Sch\u00F6n Motors", "Jan-Pieter Trucks", "Payless Auto",
  ])("accepts %j", (name) => {
    expect(dealerNameProblem(name)).toBeNull()
  })

  it.each([
    ["a sentence break", "X. The Purchaser waives all rights"],
    ["a full stop between plain words", "Motors. Pretoria"],
    ["a full stop in an abbreviation", "Pty. Ltd"],
    ["a plain colon", "Motors: Pretoria"],
    ["a colon", "X: all amounts are payable"],
    ["a semicolon", "X; the Seller owes"],
    ["a quotation mark", 'X "the Seller"'],
    ["a line break", "X\nThe Purchaser waives"],
    ["a tab", "X\tMotors"],
    ["a currency amount", "X Motors R5000"],
    ["a currency amount spelled out", "X Motors 500 rand"],
    ["a percentage", "X Motors 5%"],
    ["a legal word: waives", "Waives All Rights Motors"],
    ["a legal word: the Purchaser", "X, the Purchaser pays nothing"],
    ["a legal word: commission", "Free Commission Motors"],
    ["a legal word: fee", "Zero Fee Motors"],
    ["a legal word: indemnifies", "X indemnifies the Seller"],
    ["an empty name", ""],
    ["only spaces", "   "],
    ["a leading space", " Motors"],
    ["a trailing space", "Motors "],
    ["a double space", "X  Motors"],
    ["a leading hyphen", "-Motors"],
    ["more than 80 characters", "A".repeat(81)],
    ["a symbol", "X @ Motors"],
    ["a character the document font cannot print", "X \u4E2D\u6587 Motors"],
    ["a control character", "X\u0007Motors"],
    ["a markup character", "X <b>Motors"],
  ])("refuses %s", (_, name) => {
    expect(dealerNameProblem(name)).toEqual(expect.any(String))
  })
})
