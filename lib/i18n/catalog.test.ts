import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CATALOGS } from "./catalog"
import { LOCALES } from "./locales"

const en = CATALOGS.en as unknown as Record<string, Record<string, string>>
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort()

describe.each(LOCALES.filter((l) => l !== "en"))("catalogue %s", (locale) => {
  const catalog = CATALOGS[locale] as unknown as Record<string, Record<string, string>>

  it("has exactly the English namespaces", () => {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort())
  })

  it.each(Object.keys(en))("namespace %s has exactly the English keys", (ns) => {
    expect(Object.keys(catalog[ns] ?? {}).sort()).toEqual(Object.keys(en[ns]).sort())
  })

  it.each(Object.keys(en))("namespace %s keeps every placeholder and markup tag", (ns) => {
    for (const [key, english] of Object.entries(en[ns])) {
      const translated = catalog[ns][key]
      expect({ key, placeholders: placeholders(translated) }).toEqual({ key, placeholders: placeholders(english) })
      expect({ key, tags: tags(translated) }).toEqual({ key, tags: tags(english) })
    }
  })

  it.each(Object.keys(en))("namespace %s has no empty message", (ns) => {
    const empty = Object.entries(catalog[ns]).filter(([, v]) => v.trim() === "").map(([k]) => k)
    expect(empty).toEqual([])
  })

  it("every file is marked as a machine draft", () => {
    const dir = path.join(__dirname, "messages", locale)
    const unmarked = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !readFileSync(path.join(dir, f), "utf8").startsWith(
        "// MACHINE DRAFT — needs native-speaker review before a lender goes live.",
      ))
    expect(unmarked).toEqual([])
  })
})
