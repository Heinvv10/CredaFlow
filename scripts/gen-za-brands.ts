/**
 * Writes lib/statement-analysis/za-brands.ts: South African brand names by
 * category, from OpenStreetMap's name-suggestion-index (NSI, BSD-3-Clause).
 * Public reference data only; nothing from any statement.
 *
 *   curl -sL -o nsi.json https://cdn.jsdelivr.net/npm/name-suggestion-index@<version>/dist/json/nsi.min.json
 *   npx tsx scripts/gen-za-brands.ts nsi.json <version> [/usr/share/dict/words]
 *
 * Kept: brands whose NSI locationSet includes "za" and whose OSM tag maps to a
 * living category (TAG_CATEGORY). Dropped: names under four letters, and
 * one-word names that are ordinary English words (the dictionary file), which
 * would match a description that merely uses the word.
 */
import { readFileSync, writeFileSync } from "node:fs"
import type { LivingCategory } from "@/lib/statement-analysis/categories"

/** NSI tree path (brands/<key>/<value>) → category. Everything else is left out. */
export const TAG_CATEGORY: Record<string, LivingCategory> = {
  "brands/shop/supermarket": "FOOD", "brands/shop/convenience": "FOOD", "brands/amenity/fast_food": "FOOD",
  "brands/amenity/restaurant": "FOOD", "brands/amenity/cafe": "FOOD", "brands/shop/bakery": "FOOD",
  "brands/shop/butcher": "FOOD", "brands/shop/beverages": "FOOD", "brands/amenity/ice_cream": "FOOD",
  "brands/shop/greengrocer": "FOOD", "brands/shop/deli": "FOOD",
  "brands/shop/alcohol": "ENTERTAINMENT", "brands/amenity/cinema": "ENTERTAINMENT",
  "brands/leisure/fitness_centre": "ENTERTAINMENT", "brands/shop/ticket": "ENTERTAINMENT",
  "brands/shop/clothes": "CLOTHING", "brands/shop/shoes": "CLOTHING", "brands/shop/department_store": "CLOTHING",
  "brands/shop/sports": "CLOTHING", "brands/shop/outdoor": "CLOTHING",
  "brands/amenity/pharmacy": "MEDICAL", "brands/shop/optician": "MEDICAL", "brands/amenity/clinic": "MEDICAL",
  "brands/amenity/hospital": "MEDICAL", "brands/amenity/dentist": "MEDICAL", "brands/amenity/doctors": "MEDICAL",
  "brands/amenity/fuel": "TRANSPORT", "brands/shop/tyres": "TRANSPORT", "brands/shop/car_parts": "TRANSPORT",
  "brands/shop/mobile_phone": "UTILITIES_TELECOM",
  "brands/office/insurance": "INSURANCE", "brands/shop/funeral_directors": "INSURANCE",
  "brands/shop/books": "EDUCATION", "brands/shop/stationery": "EDUCATION", "brands/amenity/college": "EDUCATION",
  "brands/amenity/school": "EDUCATION", "brands/amenity/university": "EDUCATION",
}

const ORDER: LivingCategory[] = ["FOOD", "CLOTHING", "MEDICAL", "TRANSPORT", "UTILITIES_TELECOM", "INSURANCE", "EDUCATION", "ENTERTAINMENT"]

interface NsiItem { displayName: string; locationSet?: { include?: unknown[] }; matchNames?: string[]; tags?: Record<string, string> }

/** The forms a name takes on a statement: upper-case, accents and parentheses gone, "'" kept, dropped and spaced. */
export function variants(name: string): string[] {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\([^)]*\)/g, " ").toUpperCase()
  const forms = new Set<string>()
  for (const apostrophe of ["", " "]) {
    const s = base.replace(/['’]/g, apostrophe).replace(/[^A-Z0-9&]+/g, " ").trim()
    if (!s) continue
    forms.add(s)
    const words = s.split(" ")
    // Statement keys keep three words (counterpartyKey); a longer name is matched by its first three.
    if (words.length > 3) forms.add(words.slice(0, 3).join(" ").replace(/ &$/, ""))
    const joined = words.join("")
    if (words.length > 1 && words.length <= 3 && joined.length >= 6) forms.add(joined)
  }
  return [...forms]
}

/** Two-word names that are also what any business of the kind is called. */
const GENERIC_FORMS = new Set(["TRUCK STOP", "TRUCKSTOP"])

export function keep(form: string, english: Set<string>): boolean {
  if (form.replace(/[^A-Z]/g, "").length < 4 || GENERIC_FORMS.has(form)) return false
  return form.includes(" ") || !english.has(form.toLowerCase())
}

function main() {
  const [nsiPath, version, dictPath = "/usr/share/dict/words"] = process.argv.slice(2)
  if (!nsiPath || !version) throw new Error("usage: gen-za-brands.ts <nsi.json> <version> [words]")
  const english = new Set(readFileSync(dictPath, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean))
  const nsi = (JSON.parse(readFileSync(nsiPath, "utf8")) as { nsi: Record<string, { items?: NsiItem[] }> }).nsi
  const byCategory = new Map<LivingCategory, Set<string>>()
  for (const [path, tree] of Object.entries(nsi)) {
    const category = TAG_CATEGORY[path]
    if (!category) continue
    for (const item of tree.items ?? []) {
      if (!(item.locationSet?.include ?? []).some((c) => String(c).toLowerCase() === "za")) continue
      const names = [item.displayName, item.tags?.brand, item.tags?.name, ...(item.matchNames ?? [])].filter((n): n is string => !!n)
      for (const form of names.flatMap(variants)) if (keep(form, english)) {
        if (!byCategory.has(category)) byCategory.set(category, new Set())
        byCategory.get(category)!.add(form)
      }
    }
  }
  // A form in two categories says nothing: leave it out of both.
  const seen = new Map<string, number>()
  for (const s of byCategory.values()) for (const f of s) seen.set(f, (seen.get(f) ?? 0) + 1)
  const lines = ORDER.filter((c) => byCategory.has(c)).map((c) => {
    const forms = [...byCategory.get(c)!].filter((f) => seen.get(f) === 1).sort()
    return `  ["${c}", ${JSON.stringify(forms).replace(/","/g, '", "')}],`
  })
  writeFileSync("lib/statement-analysis/za-brands.ts", `/**
 * GENERATED by scripts/gen-za-brands.ts — do not edit; regenerate.
 * South African brand names by category from OpenStreetMap's
 * name-suggestion-index ${version} (BSD-3-Clause, github.com/osmlab/name-suggestion-index).
 * Checked after merchants.ts LIVING_MERCHANTS, so a hand-written word wins.
 */
import type { LivingCategory } from "./categories"

export const ZA_BRANDS_SOURCE = "nsi@${version}"

export const ZA_BRANDS: Array<[LivingCategory, string[]]> = [
${lines.join("\n")}
]
`)
}

if (require.main === module) main()
