// Issuing tax invoices. Every party detail and amount is copied onto the
// TaxInvoice row at issue; the database then refuses any UPDATE or DELETE,
// assigns the gap-free per-tenant number, and checks at commit that the
// totals equal the sum of the lines (migration 20261013100000).
//
// Content of a full tax invoice, VAT Act No. 89 of 1991 s20(4):
//   (a) the words "Tax Invoice" in a prominent place;
//   (b) the supplier's name, address and VAT registration number;
//   (c) the recipient's name, address and, where registered, VAT registration
//       number;
//   (d) an individual serialised number and the date of issue;
//   (e) a full and proper description of the goods or services supplied;
//   (f) the quantity or volume of the goods or services supplied;
//   (g) either the value of the supply, the amount of tax charged and the
//       consideration for the supply; or, where tax is included in the
//       consideration, the consideration and a statement that it includes a
//       charge in respect of tax and the rate at which it was charged.
// The PDF (./tax-invoice-pdf.ts) prints all of (a)-(g), using the first
// option of (g).
// UNTESTED: list to confirm with the tax advisor (drawn from s20(4) as
// enacted; SARS guidance could not be read when this was written).
import type { Prisma } from "@prisma/client"
import { dbDate } from "@/lib/asset-finance/dates"
import { addVat, splitInclusive, type VatSplit } from "./amounts"
import type { VatTransaction } from "./db"
import { loadRateOn } from "./vat-rate"

export class VatNotConfiguredError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} has no VAT configuration; it cannot issue a tax invoice`)
    this.name = "VatNotConfiguredError"
  }
}

/**
 * A line priced VAT-exclusive (quantity × unit price, VAT added half-up), or a
 * single item priced VAT-inclusive (split by the tax fraction, so exclusive +
 * VAT is exactly the inclusive price; ./amounts splitInclusive).
 */
export type TaxInvoiceLineInput =
  | { description: string; quantity: number; unitExclVatCents: number }
  | { description: string; inclVatCents: number }

export interface ComputedTaxInvoiceLine extends VatSplit {
  lineNo: number
  description: string
  quantity: number
  unitExclVatCents: number
}

export interface ComputedTaxInvoice {
  lines: ComputedTaxInvoiceLine[]
  totalExclVatCents: number
  vatCents: number
  totalInclVatCents: number
}

export interface TaxInvoiceRecipient {
  name: string
  address: string
  /** Only when the recipient is a registered vendor. */
  vatNumber?: string | null
}

export interface IssueTaxInvoiceInput {
  tenantId: string
  loanId?: string | null
  /** ISO YYYY-MM-DD. */
  issueDate: string
  /** ISO YYYY-MM-DD; selects the VAT rate. */
  supplyDate: string
  recipient: TaxInvoiceRecipient
  lines: readonly TaxInvoiceLineInput[]
  createdById?: string | null
}

export type TaxInvoiceDb = Pick<VatTransaction, "vatConfig" | "vatRate" | "taxInvoice" | "$executeRawUnsafe">

export type IssuedTaxInvoice = Prisma.TaxInvoiceGetPayload<{ include: { lines: true } }>

function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (trimmed === "") throw new RangeError(`${label} is required`)
  return trimmed
}

/**
 * Pure: each line's value and VAT (half-up per line, ./amounts) and the
 * invoice totals as the sum of the lines. An exclusive line's value is
 * quantity × unit price; an inclusive line is one item whose exclusive value
 * is the tax-fraction split of its price. The database accepts a line's VAT
 * by either rule (checkTaxInvoiceLineVat, migration 20261013100000).
 */
export function computeTaxInvoice(lines: readonly TaxInvoiceLineInput[], rateTenThousandths: number): ComputedTaxInvoice {
  if (lines.length === 0) throw new RangeError("a tax invoice needs at least one line")
  const computed = lines.map((line, i): ComputedTaxInvoiceLine => {
    const description = requireText(line.description, `lines[${i}].description`)
    if ("inclVatCents" in line) {
      if (!Number.isSafeInteger(line.inclVatCents) || line.inclVatCents <= 0) {
        throw new RangeError(`lines[${i}].inclVatCents must be a positive integer number of cents`)
      }
      const split = splitInclusive(line.inclVatCents, rateTenThousandths)
      return { lineNo: i + 1, description, quantity: 1, unitExclVatCents: split.exclVatCents, ...split }
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`lines[${i}].quantity must be a positive integer`)
    }
    if (!Number.isSafeInteger(line.unitExclVatCents) || line.unitExclVatCents <= 0) {
      throw new RangeError(`lines[${i}].unitExclVatCents must be a positive integer number of cents`)
    }
    const split = addVat(line.quantity * line.unitExclVatCents, rateTenThousandths)
    return { lineNo: i + 1, description, quantity: line.quantity, unitExclVatCents: line.unitExclVatCents, ...split }
  })
  const sum = (pick: (line: ComputedTaxInvoiceLine) => number) => computed.reduce((total, line) => total + pick(line), 0)
  return {
    lines: computed,
    totalExclVatCents: sum((line) => line.exclVatCents),
    vatCents: sum((line) => line.vatCents),
    totalInclVatCents: sum((line) => line.inclVatCents),
  }
}

/**
 * Issues a tax invoice inside the caller's transaction. Refuses with
 * VatNotConfiguredError when the tenant has no VatConfig, and NoVatRateError
 * when no rate is in force on the supply date. The number and display number
 * ("INV-000123") are assigned by the database trigger.
 */
export async function issueTaxInvoice(tx: TaxInvoiceDb, input: IssueTaxInvoiceInput): Promise<IssuedTaxInvoice> {
  const issueDate = dbDate(input.issueDate, "issueDate")
  const supplyDate = dbDate(input.supplyDate, "supplyDate")
  const recipientName = requireText(input.recipient.name, "recipient.name")
  const recipientAddress = requireText(input.recipient.address, "recipient.address")
  const recipientVatNumber = input.recipient.vatNumber?.trim() || null

  const config = await tx.vatConfig.findUnique({ where: { tenantId: input.tenantId } })
  if (!config) throw new VatNotConfiguredError(input.tenantId)
  const rate = await loadRateOn(tx, input.supplyDate)
  const invoice = computeTaxInvoice(input.lines, rate.rateTenThousandths)

  const issued = await tx.taxInvoice.create({
    data: {
      tenantId: input.tenantId,
      // Placeholders: the TaxInvoice_assign_number trigger overwrites both.
      number: 0,
      invoiceNumber: "",
      issueDate,
      supplyDate,
      loanId: input.loanId ?? null,
      supplierName: config.registeredName,
      supplierAddress: config.address,
      supplierVatNumber: config.vatNumber,
      recipientName,
      recipientAddress,
      recipientVatNumber,
      vatRate: rate.rate,
      totalExclVatCents: invoice.totalExclVatCents,
      vatCents: invoice.vatCents,
      totalInclVatCents: invoice.totalInclVatCents,
      createdById: input.createdById ?? null,
      lines: {
        create: invoice.lines.map((line) => ({
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity,
          unitExclVatCents: line.unitExclVatCents,
          exclVatCents: line.exclVatCents,
          vatCents: line.vatCents,
          inclVatCents: line.inclVatCents,
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  })
  // The totals = lines check is a deferred constraint trigger: forced here so
  // a violation fails this call, not a COMMIT that Prisma would report as
  // success (lib/loan/apply-payment.ts).
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return issued
}

export interface FinancedAsset {
  make: string
  model: string
  year: number
  serialNumber?: string | null
  vin?: string | null
}

export interface IssueInstalmentSaleInvoiceInput {
  tenantId: string
  loanId: string
  /** ISO YYYY-MM-DD the instalment sale was booked. */
  bookingDate: string
  recipient: TaxInvoiceRecipient
  asset: FinancedAsset
  /** The asset's cash price, VAT-INCLUSIVE: the solver's cashPriceCents, what the supplier is paid. */
  cashPriceCents: number
  createdById?: string | null
}

/** "2024 Testmake Model X, serial no. TESTSERIAL001, VIN TEST0000000000001". */
export function describeAsset(asset: FinancedAsset): string {
  if (!Number.isInteger(asset.year) || asset.year < 1900) throw new RangeError("asset.year must be a model year")
  const serial = asset.serialNumber?.trim()
  const vin = asset.vin?.trim()
  if (!serial && !vin) throw new RangeError("asset needs a serial number or a VIN")
  return [
    `${asset.year} ${requireText(asset.make, "asset.make")} ${requireText(asset.model, "asset.model")}`,
    ...(serial ? [`serial no. ${serial}`] : []),
    ...(vin ? [`VIN ${vin}`] : []),
  ].join(", ")
}

/**
 * The inception tax invoice of an instalment sale: exactly ONE line, the
 * asset at its VAT-inclusive cash price, split by the tax fraction so that
 * exclusive value + VAT equals the cash price to the cent (asserted: the
 * invoice must state the consideration the deal finances). Finance charges are never
 * a line: interest on the credit is an exempt financial service (VAT Act
 * s12(a) read with the definition of "financial services" in s2), so it
 * carries no VAT and does not belong on the tax invoice.
 *
 * UNTESTED: tax memo pending — the supply is treated as made, and the
 * invoice issued, on the booking date (the time-of-supply rule for
 * instalment credit agreements, s9(3)(c), as we read it). DESIGN.md D7
 * requires a signed tax-advisor memo on supply timing before this ships.
 */
export async function issueInstalmentSaleInvoice(
  tx: TaxInvoiceDb,
  input: IssueInstalmentSaleInvoiceInput,
): Promise<IssuedTaxInvoice> {
  const invoice = await issueTaxInvoice(tx, {
    tenantId: input.tenantId,
    loanId: input.loanId,
    issueDate: input.bookingDate,
    supplyDate: input.bookingDate,
    recipient: input.recipient,
    lines: [{ description: describeAsset(input.asset), inclVatCents: input.cashPriceCents }],
    createdById: input.createdById,
  })
  if (invoice.totalExclVatCents + invoice.vatCents !== input.cashPriceCents || invoice.totalInclVatCents !== input.cashPriceCents) {
    throw new Error(`tax invoice ${invoice.invoiceNumber}: exclusive + VAT does not equal the cash price ${input.cashPriceCents}`)
  }
  return invoice
}
