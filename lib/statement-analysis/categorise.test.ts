import { describe, expect, it } from "vitest"
import { categorise, CATEGORISER_VERSION, isLiving, LIVING_CATEGORIES, type Category } from "./categorise"
import type { StatementTransaction } from "./types"

const tx = (description: string, amountCents: number, extra: Partial<StatementTransaction> = {}): StatementTransaction =>
  ({ date: "2026-08-01", description, amountCents, balanceCents: null, page: 1, ...extra })
const cat = (description: string, amountCents = -10_000, clientName: string | null = "Thabo Tester") =>
  categorise(tx(description, amountCents), { clientName }).category

describe("categorise", () => {
  it("names its version, so a stored flag says which rules it came from", () => {
    expect(CATEGORISER_VERSION).toMatch(/^categoriser-v\d+$/)
  })

  it.each<[string, Category]>([
    ["Card Purchase: SHOPRITE SOWETO", "FOOD"],
    ["POS PURCHASE CHECKERS HYPER", "FOOD"],
    ["Card Purchase: UBER EATS PARKTOWN", "FOOD"],
    ["DL UBER CPT", "TRANSPORT"],
    ["POS PURCHASE ENGEN GARAGE", "TRANSPORT"],
    ["Card Purchase: PEP STORES", "CLOTHING"],
    ["NETFLIX.COM AMSTERDAM", "ENTERTAINMENT"],
    ["POS PURCHASE DISCHEM", "MEDICAL"],
    ["DebiCheck: CAPITECINS", "INSURANCE"],
    ["Banking App Electricity", "UTILITIES_TELECOM"],
    ["Prepaid Airtime: VODACOM", "UTILITIES_TELECOM"],
    ["Payment To: SYNTH RENTALS RENT", "HOUSING"],
    ["DEBIT ORDER SYNTH PRIMARY SCHOOL FEES", "EDUCATION"],
  ])("puts %s in a living category: %s", (description, expected) => {
    expect(cat(description)).toBe(expected)
    expect(isLiving(expected)).toBe(true)
  })

  it.each<[string, Category]>([
    ["Card Purchase: HOLLYWOODBETS", "GAMBLING"],
    ["OTT BETTING LOTTERY VOUCHER", "GAMBLING"],
    ["DebiCheck Debit: SYNTHLEND FINANCE", "CREDIT_INSTALMENT"],
    ["PAYFLEX SANDTON CARD", "CREDIT_INSTALMENT"],
    ["DebiCheck Insufficient Funds Fee", "RETURNED_DEBIT"],
    ["Monthly Account Admin Fee", "BANK_FEES"],
    ["SMS Payment Notification", "BANK_FEES"],
    ["ATM Cash Withdrawal", "CASH_WITHDRAWAL"],
    ["Send Money App", "CASH_WITHDRAWAL"],
    ["Payment To Investment Account", "SAVINGS_INVESTMENT"],
    ["Inter account transfer to savings", "TRANSFER_OWN"],
    ["Payment To: J SOAP", "UNCATEGORISED"],
  ])("keeps %s out of living spend: %s", (description, expected) => {
    expect(cat(description)).toBe(expected)
    expect(isLiving(expected)).toBe(false)
  })

  it("reads school fees as education, not a bank fee", () => {
    expect(cat("SYNTH HIGH SCHOOL FEES")).toBe("EDUCATION")
    expect(cat("Card Machine Fee")).toBe("BANK_FEES")
  })

  it("reads a payment to the client's own name as a transfer between their accounts", () => {
    expect(cat("IB Transfer To: THABO TESTER", -50_000)).toBe("TRANSFER_OWN")
    expect(cat("IB Transfer To: THABO TESTER", -50_000, null)).toBe("UNCATEGORISED")
    // A relative shares the surname, not the whole name.
    expect(cat("IB Transfer To: SIPHO TESTER", -50_000)).toBe("UNCATEGORISED")
  })

  it("splits money in into salary, own transfers and other income", () => {
    expect(cat("Payment Received: SALARY SYNTHCO", 1_845_000)).toBe("SALARY_INCOME")
    expect(cat("SYNTHCO WAGES", 500_000)).toBe("SALARY_INCOME")
    expect(cat("Inter account transfer from savings", 50_000)).toBe("TRANSFER_OWN")
    expect(cat("Payment Received: SHOPRITE REFUND", 5_000)).toBe("OTHER_INCOME")
  })

  it("matches names as words, not inside other words", () => {
    expect(cat("Card Purchase: USAVE CARD")).toBe("FOOD")
    expect(cat("SPARKLING SYNTH WASH")).toBe("UNCATEGORISED")
  })

  it("says which rule decided", () => {
    expect(categorise(tx("Card Purchase: HOLLYWOODBETS", -1), { clientName: null }).rule).toBe("policy:GAMBLING_MERCHANTS")
    expect(categorise(tx("Card Purchase: SHOPRITE", -1), { clientName: null }).rule).toBe("merchant:FOOD")
  })

  it("maps every living category to a declared-expense field", () => {
    expect(LIVING_CATEGORIES).toEqual(["HOUSING", "TRANSPORT", "FOOD", "EDUCATION", "INSURANCE", "CLOTHING", "ENTERTAINMENT", "MEDICAL", "UTILITIES_TELECOM"])
  })
})
