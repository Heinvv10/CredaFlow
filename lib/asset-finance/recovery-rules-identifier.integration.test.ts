/**
 * The buyer identifier key (migration 20261015400000), one SQL function the
 * trigger uses and lib/asset-finance/recovery-screening.ts canonicalIdentifier
 * mirrors: NFKC, every Unicode decimal digit as ASCII, only letters and
 * digits, upper case; letters around an otherwise all-digit key of 6 or more
 * digits dropped; a CIPC registration number (CK prefix, six-digit number,
 * suffix) as year + number + the suffix as a number. A table of inputs, the
 * attacker's variants of an ID number and of a registration number among
 * them, goes through both; the SQL key must equal the TypeScript one, and each
 * part of the rule is shown to be what makes it so (the part taken out of the
 * function, the key differs). The registration forms are UNTESTED against
 * CIPC's own.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-identifier.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { attempt } from "./lease-servicing.integration-fixture"
import { canonicalIdentifier } from "./recovery-screening"
import { clauseOff } from "./recovery-rules.integration-fixture"

// The fixtures import the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}

const ID = "8001015009087"
const REG = "20981234565" // 2098 / 123456 / 5
const asScript = (digits: string, zero: number) => [...digits].map((c) => (/\d/.test(c) ? String.fromCodePoint(zero + Number(c)) : c)).join("")

/** The key the database makes of a value, with `without` taken out of the function when given. */
async function sqlKey(value: string, without?: Parameters<typeof attempt>[2]): Promise<string> {
  let key = ""
  const result = await attempt(database(), async (tx) => {
    key = (await tx.$queryRawUnsafe<{ k: string }[]>(`SELECT public."recoveryIdentifierKey"($1) AS k`, value))[0].k
  }, without)
  expect(result).toBe("ok")
  return key
}

const TABLE: [string, string][] = [
  ["empty", ""], ["only separators", " -/. "],
  ["ID", ID], ["ID with spaces", "800101 5009 087"], ["ID with dashes", "800101-5009-087"], ["ID with a label", "id: 8001015009087"], ["ID with a long label", "Identity No 8001015009087"],
  ["ID with a trailing label", "8001015009087 (ID)"], ["ID with zero-width space", `${ID}​`], ["ID with apostrophe and tab", `'\t${ID}`],
  ["ID in fullwidth digits", asScript(ID, 0xff10)], ["ID in Arabic-Indic digits", asScript(ID, 0x660)], ["ID in Extended Arabic-Indic digits", asScript(ID, 0x6f0)],
  ["ID in Devanagari digits", asScript(ID, 0x966)], ["ID in Thai digits", asScript(ID, 0xe50)], ["ID in mathematical bold digits", asScript(ID, 0x1d7ce)],
  ["ID in superscript digits", "⁸⁰⁰¹⁰¹⁵⁰⁰⁹⁰⁸⁷"], ["ID with a label in fullwidth letters", `ＩＤ ${ID}`],
  ["letters without enough digits", "AB12345"], ["a label longer than 8 letters", `ABCDEFGHIJ${ID}`], ["letters inside the digits", "800101A5009087"], ["a licence plate", "CA 123-456"],
  ["registration", "2098/123456/05"], ["registration, no slashes", "209812345605"], ["registration, spaces", "2098 / 123456 / 05"], ["registration, lower case", "ck2098/123456/05"],
  ["registration, unpadded suffix", "2098/123456/5"], ["registration, CK prefix", "CK2098/123456/05"], ["registration, CK prefix and unpadded suffix", "CK 2098/123456/5"],
  ["registration, other suffix", "2098/123456/07"], ["registration, suffix 00", "2098/123456/00"], ["registration, suffix 10", "2098/123456/10"],
  ["registration, no suffix", "2098/123456"], ["registration, 11 digits", "20981234565"], ["registration, fullwidth", "２０９８／１２３４５６／０５"],
  ["registration, Arabic-Indic", asScript("209812345605", 0x660)], ["registration, label", "Reg: 2098/123456/05"], ["registration, trailing label", "2098/123456/05 PTY"],
  ["trust number", "IT 1234/2020"], ["CK without a number", "CK"], ["an older CIPC form", "CK2098/12345/05"],
]

suite("buyer identifier key: the SQL function and the TypeScript screening agree", () => {
  afterAll(async () => { await db?.$disconnect() }, 60_000)

  it("gives every input in the table the key the screening gives it", async () => {
    const disagree: string[] = []
    for (const [label, value] of TABLE) {
      const sql = await sqlKey(value)
      const ts = canonicalIdentifier(value)
      if (sql !== ts) disagree.push(`${label} ${JSON.stringify(value)}: sql ${sql} / ts ${ts}`)
    }
    expect(disagree).toEqual([])
  })

  it("makes the attacker's variants of an ID number and of a registration number one key each", async () => {
    const ids = TABLE.filter(([label]) => label.startsWith("ID") && !label.includes("long label")).map(([, value]) => value)
    for (const value of ids) expect(await sqlKey(value), JSON.stringify(value)).toBe(ID)
    const registrations = TABLE.filter(([label]) => label.startsWith("registration") && !/other suffix|suffix 00|suffix 10|no suffix/.test(label)).map(([, value]) => value)
    for (const value of registrations) expect(await sqlKey(value), JSON.stringify(value)).toBe(REG)
  })

  it("keeps different numbers apart: another suffix, a missing suffix, too few digits, a long label, letters inside", async () => {
    expect(await sqlKey("2098/123456/07")).toBe("20981234567")
    expect(await sqlKey("2098/123456/05")).not.toBe(await sqlKey("2098/123456/07"))
    expect(await sqlKey("2098/123456")).toBe("2098123456")
    expect(await sqlKey("2098/123456")).not.toBe(REG)
    expect(await sqlKey("AB12345")).toBe("AB12345")
    expect(await sqlKey(`ABCDEFGHIJ${ID}`)).toBe(`ABCDEFGHIJ${ID}`)
    expect(await sqlKey("800101A5009087")).toBe("800101A5009087")
    expect(await sqlKey("2098/123456/10")).toBe("209812345610")
  })

  describe("each step of the rule is what makes the key", () => {
    it("NFKC", async () => {
      expect(await sqlKey("⁸⁰⁰¹⁰¹⁵⁰⁰⁹⁰⁸⁷", clauseOff("recoveryAsciiDigits", `normalize(COALESCE(value, ''), NFKC)`, `COALESCE(value, '')`))).not.toBe(ID)
    })

    it("the digits of other scripts", async () => {
      expect(await sqlKey(asScript(ID, 0x660), clauseOff("recoveryAsciiDigits", `string_agg(d::TEXT, '' ORDER BY b, d)`, `string_agg('x', '' ORDER BY b, d)`))).not.toBe(ID)
    })

    it("dropping the letters around a numeric key", async () => {
      expect(await sqlKey("id: 8001015009087", clauseOff("recoveryIdentifierKey", `    k := bare;`))).not.toBe(ID)
    })

    it("the registration number's canonical form: the suffix as a number, and the year, number and suffix split", async () => {
      expect(await sqlKey("2098/123456/5", clauseOff("recoveryIdentifierKey", `(registration[3]::INTEGER)::TEXT`, `lpad(registration[3], 2, '0')`))).not.toBe(REG)
      expect(await sqlKey("CK2098/123456/05", clauseOff("recoveryIdentifierKey", `IF registration IS NOT NULL THEN`, `IF false THEN`))).not.toBe(REG)
    })
  })
})
