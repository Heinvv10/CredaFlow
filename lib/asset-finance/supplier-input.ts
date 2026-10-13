/**
 * Validation of suppliers, supplier bank-account requests and the decision on
 * a request (app/api/asset-finance/suppliers/**). DESIGN D8: a supplier is
 * paid only into an account a second, different user approved.
 */
import { asRecord, readBool, readEnum, readText, type Errors, type Fields } from "./input-fields"

type Parsed<T> = { data: T } | { errors: Errors }

export interface SupplierFields {
  name: string
  registrationNumber: string | null
  vatNumber: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  active: boolean
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// A South African VAT registration number: ten digits starting with 4.
const SA_VAT_NUMBER = /^4\d{9}$/

function parseSupplier(body: unknown, partial: boolean): Parsed<Fields> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const out: Fields = {}
  const errors: Errors = {}
  readText(record, "name", out, errors, { required: !partial, nullable: false, max: 160 })
  readText(record, "registrationNumber", out, errors, { required: false, nullable: true, max: 32, upper: true })
  readText(record, "vatNumber", out, errors, { required: false, nullable: true, max: 10 })
  readText(record, "contactName", out, errors, { required: false, nullable: true, max: 120 })
  readText(record, "contactEmail", out, errors, { required: false, nullable: true, max: 160 })
  readText(record, "contactPhone", out, errors, { required: false, nullable: true, max: 32 })
  readText(record, "address", out, errors, { required: false, nullable: true, max: 300 })
  if (partial) readBool(record, "active", out, errors)
  if (typeof out.vatNumber === "string" && !SA_VAT_NUMBER.test(out.vatNumber)) {
    errors.vatNumber = "must be a 10-digit VAT number starting with 4"
  }
  if (typeof out.contactEmail === "string" && !EMAIL.test(out.contactEmail)) {
    errors.contactEmail = "must be an email address"
  }
  if (Object.keys(errors).length > 0) return { errors }
  if (partial && Object.keys(out).length === 0) return { errors: { body: "has no supplier fields to change" } }
  return { data: out }
}

export function parseSupplierCreate(body: unknown): Parsed<SupplierFields> {
  const parsed = parseSupplier(body, false)
  if ("errors" in parsed) return parsed
  const defaults = {
    registrationNumber: null, vatNumber: null, contactName: null, contactEmail: null,
    contactPhone: null, address: null, active: true,
  }
  return { data: { ...defaults, ...parsed.data } as SupplierFields }
}

export function parseSupplierUpdate(body: unknown): Parsed<Partial<SupplierFields>> {
  const parsed = parseSupplier(body, true)
  if ("errors" in parsed) return parsed
  return { data: parsed.data as Partial<SupplierFields> }
}

export const BANK_ACCOUNT_TYPES = ["CHEQUE", "SAVINGS", "TRANSMISSION"] as const

export interface BankAccountFields {
  bankName: string
  branchCode: string
  accountNumber: string
  accountHolder: string
  accountType: (typeof BANK_ACCOUNT_TYPES)[number] | null
}

export function parseBankAccountRequest(body: unknown): Parsed<BankAccountFields> {
  const record = asRecord(body)
  if (!record) return { errors: { body: "must be a JSON object" } }
  const out: Fields = {}
  const errors: Errors = {}
  readText(record, "bankName", out, errors, { required: true, nullable: false, max: 80 })
  readText(record, "accountHolder", out, errors, { required: true, nullable: false, max: 160 })
  if (record.accountType !== undefined && record.accountType !== null && record.accountType !== "") {
    readEnum(record, "accountType", out, errors, { required: true, values: BANK_ACCOUNT_TYPES })
  }
  const branchCode = typeof record.branchCode === "string" ? record.branchCode.replace(/\s+/g, "") : ""
  if (!/^\d{6}$/.test(branchCode)) errors.branchCode = "must be a 6-digit branch code"
  const accountNumber = typeof record.accountNumber === "string" ? record.accountNumber.replace(/[\s-]+/g, "") : ""
  if (!/^\d{6,16}$/.test(accountNumber)) errors.accountNumber = "must be 6 to 16 digits"
  if (Object.keys(errors).length > 0) return { errors }
  return { data: { accountType: null, ...out, branchCode, accountNumber } as BankAccountFields }
}

export type BankAccountDecision = "APPROVE" | "REJECT"

const MIN_NOTE = 10
const MAX_NOTE = 2000

/**
 * `{ decision, note }`. On APPROVE the note is the verification evidence the
 * approver relied on (see lib/asset-finance/supplier-avs.ts); on REJECT, why.
 */
export function parseBankAccountDecision(body: unknown): { decision: BankAccountDecision; note: string } | string {
  const record = asRecord(body)
  if (!record) return "Body must be a JSON object"
  const { decision, note } = record
  if (decision !== "APPROVE" && decision !== "REJECT") return "decision must be APPROVE or REJECT"
  const trimmed = typeof note === "string" ? note.trim() : ""
  if (trimmed.length < MIN_NOTE || trimmed.length > MAX_NOTE) {
    return decision === "APPROVE"
      ? `note must say how the account was verified (${MIN_NOTE} to ${MAX_NOTE} characters)`
      : `note must give the reason (${MIN_NOTE} to ${MAX_NOTE} characters)`
  }
  return { decision, note: trimmed }
}
