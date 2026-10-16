import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as policy from "@/lib/credit-checks/policy"
import * as merchants from "./merchants"
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
    // categoriser-v3: a POS key keeps one word of the merchant; names known from that word.
    ["POS PURCHASE PICK", "FOOD"],
    ["POS PURCHASE DIS", "MEDICAL"],
    ["POS PURCHASE CELL", "UTILITIES_TELECOM"],
    ["Card Purchase: PICKNPAY SOWETO", "FOOD"],
    ["Prepaid: CELLC TOPUP", "UTILITIES_TELECOM"],
  ])("puts %s in a living category: %s", (description, expected) => {
    expect(cat(description)).toBe(expected)
    expect(isLiving(expected)).toBe(true)
  })

  it.each<[string, Category]>([
    ["Card Purchase: HOLLYWOODBETS", "GAMBLING"],
    ["OTT BETTING LOTTERY VOUCHER", "GAMBLING"],
    ["DebiCheck Debit: SYNTHLEND FINANCE", "CREDIT_INSTALMENT"],
    ["PAYFLEX SANDTON CARD", "CREDIT_INSTALMENT"],
    ["DebiCheck: SA TAXI", "CREDIT_INSTALMENT"],
    ["TOYOTA FINANCIAL SERVICES", "CREDIT_INSTALMENT"],
    ["DebiCheck Insufficient Funds Fee", "RETURNED_DEBIT"],
    ["Monthly Account Admin Fee", "BANK_FEES"],
    ["SMS Payment Notification", "BANK_FEES"],
    ["ATM Cash Withdrawal", "CASH_WITHDRAWAL"],
    ["Send Money App", "CASH_WITHDRAWAL"],
    ["Payment To Investment Account", "SAVINGS_INVESTMENT"],
    ["Inter account transfer to savings", "TRANSFER_OWN"],
    ["Payment To: J SOAP", "UNCATEGORISED"],
    // Generic words and names categoriser-v3 must not file as living spend.
    ["IMMEDIATE PAYMENT TOP UP T TESTER", "UNCATEGORISED"],
    ["EFT BUNDLE OF JOY DONATION", "UNCATEGORISED"],
    ["PAYSHAP TO LEVIS TESTER", "UNCATEGORISED"],
    ["PAYMENT HBO TESTER", "UNCATEGORISED"],
    ["POS PURCHASE STUDIO HAIR SALON", "UNCATEGORISED"],
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

describe("words that used to misfile common descriptions (review of #73)", () => {
  it.each<[string, Category]>([
    ["Card Purchase: LIFE HEALTHCARE SYNTH", "MEDICAL"],
    ["DEBIT ORDER EKURHULENI METROPOLITAN MUNICIPALITY", "UTILITIES_TELECOM"],
    ["Card Purchase: TOTAL SPORTS SYNTH", "CLOTHING"],
    ["POS PURCHASE TOTAL GARAGE", "TRANSPORT"],
    ["TV LICENCE SYNTH", "UNCATEGORISED"],
    ["CHILD MAINTENANCE SYNTH", "UNCATEGORISED"],
    ["Payment To: J SOAP REPAYMENT", "UNCATEGORISED"],
    ["SYNTH PRIMARY SCHOOL INSTALMENT", "EDUCATION"],
    ["Card Purchase: PUMA ENERGY SYNTH", "TRANSPORT"],
    ["DEBIT ORDER DISCOVERY LIFE", "INSURANCE"],
    ["SYNTH FAMILY COVER", "INSURANCE"],
  ])("%s → %s", (description, expected) => {
    expect(cat(description)).toBe(expected)
  })
})

describe("model labels", () => {
  const labels = { "SYNTH SHOPRITE": "TRANSPORT", "SYNTH CORNER": "FOOD", "T TESTER": "UNCATEGORISED", "SYNTH MYSTERY": "SALARY_INCOME" }
  const withLabels = (description: string, amountCents = -10_000) => categorise(tx(description, amountCents), { clientName: "Thabo Tester", modelLabels: labels })

  it("never override a rule: rules first", () => {
    // The model says TRANSPORT; the SHOPRITE rule says FOOD and wins.
    expect(withLabels("Card Purchase: SYNTH SHOPRITE")).toEqual({ category: "FOOD", rule: "merchant:FOOD" })
  })

  it("categorise a debit no rule could, marked model-assigned", () => {
    expect(withLabels("Card Purchase: SYNTH CORNER 4411")).toEqual({ category: "FOOD", rule: "model", modelAssigned: true })
    expect(cat("Card Purchase: SYNTH CORNER 4411")).toBe("UNCATEGORISED")
  })

  it("never apply to money in", () => {
    expect(withLabels("SYNTH CORNER", 10_000).category).toBe("OTHER_INCOME")
  })

  it("leave a row uncategorised when the label is UNCATEGORISED or not one the model may give", () => {
    expect(withLabels("Payment To: T TESTER").category).toBe("UNCATEGORISED")
    expect(withLabels("SYNTH MYSTERY").category).toBe("UNCATEGORISED")
  })
})

describe("CATEGORISER_VERSION names the rules", () => {
  // A changed word list, rule or policy list changes figures and flag keys: bump
  // the version, then re-pin. Categories are never stored, so a bump re-reads nothing.
  it("is bumped whenever the rules change", () => {
    const rules = JSON.stringify({
      merchants, categorise: readFileSync(join(__dirname, "categorise.ts"), "utf8"), living: LIVING_CATEGORIES,
      policy: [policy.CREDIT_PROVIDERS, policy.CREDIT_WORD_MARKERS.source, policy.GAMBLING_MERCHANTS, policy.PAYDAY_LENDERS, policy.RETURNED_DEBIT_MARKERS.source],
    })
    const hash = createHash("sha256").update(rules).digest("hex").slice(0, 16)
    expect({ version: CATEGORISER_VERSION, hash }).toEqual({ version: "categoriser-v3", hash: "cc7e08f3c830464d" })
  })
})
