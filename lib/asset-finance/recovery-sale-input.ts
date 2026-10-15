import type { RemarketingBuyerType, SaleChannel } from "@prisma/client"

export interface SaleInput {
  channel: SaleChannel
  buyerType: RemarketingBuyerType
  buyerName: string
  buyerIdentifier: string
  buyerAddress: string
  buyerVatNumber: string | null
  priceInclVatCents: number
  valuationId: string
  belowValuationReason: string | null
}

export type ParsedSaleInput = { ok: true; value: SaleInput } | { ok: false; error: string }

const CHANNELS: readonly SaleChannel[] = ["AUCTION", "DEALER", "PRIVATE_TENDER", "DEBTOR_OR_SURETY"]
const BUYER_TYPES: readonly RemarketingBuyerType[] = ["PERSON", "ENTITY"]

type Field = string | { error: string }

function field(raw: Record<string, unknown>, key: string, min: number, max: number): Field {
  const value = raw[key]
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed.length >= min && trimmed.length <= max ? trimmed : { error: `${key} must be ${min} to ${max} characters` }
}

function optionalField(raw: Record<string, unknown>, key: string, max: number): Field | null {
  const value = raw[key]
  return value === undefined || value === null || value === "" ? null : field(raw, key, 1, max)
}

/** The body of a sale proposal; the database repeats the money and valuation rules. */
export function parseSaleInput(body: unknown): ParsedSaleInput {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  if (typeof raw.channel !== "string" || !(CHANNELS as readonly string[]).includes(raw.channel)) {
    return { ok: false, error: `channel must be one of ${CHANNELS.join(", ")}` }
  }
  if (typeof raw.buyerType !== "string" || !(BUYER_TYPES as readonly string[]).includes(raw.buyerType)) {
    return { ok: false, error: `buyerType must be one of ${BUYER_TYPES.join(", ")}` }
  }
  if (typeof raw.priceInclVatCents !== "number" || !Number.isSafeInteger(raw.priceInclVatCents) || raw.priceInclVatCents <= 0) {
    return { ok: false, error: "priceInclVatCents must be a positive integer number of cents" }
  }
  const buyerName = field(raw, "buyerName", 2, 200)
  const buyerIdentifier = field(raw, "buyerIdentifier", 3, 50)
  const buyerAddress = field(raw, "buyerAddress", 5, 500)
  const valuationId = field(raw, "valuationId", 1, 100)
  const buyerVatNumber = optionalField(raw, "buyerVatNumber", 30)
  const belowValuationReason = optionalField(raw, "belowValuationReason", 1_000)
  for (const value of [buyerName, buyerIdentifier, buyerAddress, valuationId, buyerVatNumber, belowValuationReason]) {
    if (typeof value === "object" && value !== null) return { ok: false, error: value.error }
  }
  return {
    ok: true,
    value: {
      channel: raw.channel as SaleChannel,
      buyerType: raw.buyerType as RemarketingBuyerType,
      buyerName: buyerName as string,
      buyerIdentifier: buyerIdentifier as string,
      buyerAddress: buyerAddress as string,
      buyerVatNumber: buyerVatNumber as string | null,
      priceInclVatCents: raw.priceInclVatCents,
      valuationId: valuationId as string,
      belowValuationReason: belowValuationReason as string | null,
    },
  }
}
