/**
 * The insurance catalogue, captured the way the back office does once the
 * insurer arrangement is signed (Settings → Insurers, Settings → Products →
 * Insurance, the product's Rates and Eligibility screens):
 *
 *   - the underwriter (POST /api/insurers, ADMIN);
 *   - a standalone funeral product (POST /api/products/insurance, ADMIN). No
 *     CREDIT_LIFE product is created: with CREDIT_LIFE_AUTO_BUNDLE_ENABLED=false
 *     cover can never be ACCEPTED on a loan, and an offered product would make
 *     every later application record a declined election;
 *   - the insurer's age-banded rate card (rate table + bands, then activate;
 *     INSURANCE_OFFICER) and its mandatory acceptance terms (eligibility
 *     rules). Readiness (lib/insurance/product-readiness.ts) needs both.
 *
 * Premiums are the insurer's (fictional) card, not computed here.
 */
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { recallOptional, remember, type Breadth } from "./context"

type LifeType = "MAIN_MEMBER" | "SPOUSE" | "CHILD" | "EXTENDED_FAMILY"

/** [lifeType, minAge, maxAge, cover (R), monthly premium (R)] */
const BANDS: ReadonlyArray<readonly [LifeType, number, number, number, number]> = [
  ["MAIN_MEMBER", 18, 39, 10_000, 62], ["MAIN_MEMBER", 18, 39, 20_000, 118], ["MAIN_MEMBER", 18, 39, 30_000, 172],
  ["MAIN_MEMBER", 40, 54, 10_000, 89], ["MAIN_MEMBER", 40, 54, 20_000, 171], ["MAIN_MEMBER", 40, 54, 30_000, 249],
  ["MAIN_MEMBER", 55, 64, 10_000, 138], ["MAIN_MEMBER", 55, 64, 20_000, 268], ["MAIN_MEMBER", 55, 64, 30_000, 395],
  ["SPOUSE", 18, 39, 10_000, 58], ["SPOUSE", 18, 39, 20_000, 110], ["SPOUSE", 18, 39, 30_000, 161],
  ["SPOUSE", 40, 54, 10_000, 84], ["SPOUSE", 40, 54, 20_000, 162], ["SPOUSE", 40, 54, 30_000, 236],
  ["SPOUSE", 55, 64, 10_000, 131], ["SPOUSE", 55, 64, 20_000, 255], ["SPOUSE", 55, 64, 30_000, 377],
  ["CHILD", 0, 21, 5_000, 12], ["CHILD", 0, 21, 10_000, 21],
  ["EXTENDED_FAMILY", 18, 64, 5_000, 34], ["EXTENDED_FAMILY", 18, 64, 10_000, 63],
  ["EXTENDED_FAMILY", 65, 74, 5_000, 71], ["EXTENDED_FAMILY", 65, 74, 10_000, 136],
]

/** [ruleType, lifeScope, value] — the insurer's acceptance terms. */
const RULES: ReadonlyArray<readonly [string, string, number]> = [
  ["MIN_ENTRY_AGE", "MAIN_MEMBER", 18], ["MIN_ENTRY_AGE", "SPOUSE", 18], ["MIN_ENTRY_AGE", "CHILD", 0], ["MIN_ENTRY_AGE", "EXTENDED_FAMILY", 18],
  ["MAX_ENTRY_AGE", "MAIN_MEMBER", 64], ["MAX_ENTRY_AGE", "SPOUSE", 64], ["MAX_ENTRY_AGE", "CHILD", 21], ["MAX_ENTRY_AGE", "EXTENDED_FAMILY", 74],
  ["MAX_COVER", "ALL_LIVES", 30_000],
  ["WAITING_PERIOD_DAYS", "ALL_LIVES", 90],
  ["MAX_TOTAL_COVER", "ALL_LIVES", 80_000],
]

export const FUNERAL_PRODUCT_CODE = "FUN-FAMILY"

async function ensureInsurer(admin: SimClient, b: Breadth): Promise<string> {
  const known = recallOptional(b, "insurer")
  if (known) return known
  const created = await admin.post<{ id: string }>("/api/insurers", {
    name: "Umoya Life Assurance (demo)",
    fspNumber: "99001",
    contactName: "Broker Services Desk",
    contactEmail: "brokers@umoya-life.invalid",
    contactPhone: "+27215550190",
    active: true,
  }, { expect: [200, 201] })
  if (!created.json?.id) throw new Error(`insurer create returned no id: ${created.text.slice(0, 200)}`)
  remember(b, "insurer", created.json.id)
  return created.json.id
}

async function ensureProduct(admin: SimClient, b: Breadth, insurerId: string): Promise<string> {
  const known = recallOptional(b, "funeral-product")
  if (known) return known
  const created = await admin.post<{ id: string }>("/api/products/insurance", {
    code: FUNERAL_PRODUCT_CODE,
    name: "Family Funeral Plan",
    type: "FUNERAL_COVER",
    // Flat figures are ignored for rated products (the ACTIVE rate card prices
    // every quote); the form still asks for them.
    premiumAmount: 118,
    sumAssured: 20_000,
    commissionRate: 0.2,
    insurerId,
  }, { expect: [201] })
  if (!created.json?.id) throw new Error(`product create returned no id: ${created.text.slice(0, 200)}`)
  remember(b, "funeral-product", created.json.id)
  return created.json.id
}

async function ensureRateCard(officer: SimClient, b: Breadth, productId: string, insurerId: string): Promise<void> {
  if (recallOptional(b, "rate-table-active")) return
  let tableId = recallOptional(b, "rate-table")
  if (!tableId) {
    const table = await officer.post<{ id: string }>("/api/insurance/rate-tables", {
      productId, insurerId, name: "Umoya Family Funeral — 2026 card", basis: "AGE_BANDED",
    }, { expect: [200, 201] })
    if (!table.json?.id) throw new Error(`rate table create returned no id: ${table.text.slice(0, 200)}`)
    tableId = table.json.id
    remember(b, "rate-table", tableId)
  }
  const existing = (await officer.get<Array<{ lifeType: string; minAge: number; sumAssured: string | number }>>(`/api/insurance/rate-tables/${tableId}/bands`)).json ?? []
  for (const [lifeType, minAge, maxAge, cover, premium] of BANDS) {
    if (existing.some((x) => x.lifeType === lifeType && x.minAge === minAge && Number(x.sumAssured) === cover)) continue
    await officer.post(`/api/insurance/rate-tables/${tableId}/bands`, { lifeType, minAge, maxAge, sumAssured: cover, premiumAmount: premium }, { expect: [200, 201] })
  }
  const rules = (await officer.get<Array<{ ruleType: string; lifeScope: string }>>(`/api/insurance/eligibility-rules?productId=${productId}`)).json ?? []
  for (const [ruleType, lifeScope, value] of RULES) {
    if (rules.some((r) => r.ruleType === ruleType && r.lifeScope === lifeScope)) continue
    await officer.post("/api/insurance/eligibility-rules", { productId, ruleType, lifeScope, numericValue: value }, { expect: [200, 201] })
  }
  await officer.post(`/api/insurance/rate-tables/${tableId}/activate`, {}, { expect: [200, 201] })
  remember(b, "rate-table-active", tableId)
}

/** Insurer, funeral product, rate card and acceptance terms; returns the product id. */
export async function ensureFuneralCatalogue(b: Breadth, admin: SimClient, officer: SimClient): Promise<string> {
  const insurerId = await ensureInsurer(admin, b)
  const productId = await ensureProduct(admin, b, insurerId)
  await ensureRateCard(officer, b, productId, insurerId)
  log(`insurance: Family Funeral Plan sellable (${BANDS.length} bands, ${RULES.length} acceptance terms)`)
  return productId
}
