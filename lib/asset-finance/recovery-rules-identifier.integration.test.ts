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
  ["registration, short middle", "2098/12345/05"], ["registration, padded middle", "2098/012345/05"], ["registration, short middle, spaced, suffix 5", "2098 / 12345 / 5"],
  ["registration, short middle, CK and dashes", "CK 2098-12345-05"], ["registration, short middle, underscores", "2098_012345_05"], ["registration, one-digit middle", "2098/1/05"],
  ["registration, short middle, label", "Reg 2098/12345/05"], ["registration, short middle, trailing company word", "2098/12345/05 (Pty)"], ["registration, spaces only", "2098 123456 05"],
  ["registration, an odd split", "20981234 5605"], ["registration, short middle, no separators", "209801234505"], ["registration, 7-digit middle", "2098/1234567/05"],
  ["registration, short middle, fullwidth", "２０９８／１２３４５／０５"], ["registration, short middle, zero-width separators", "2098\u200b12345\u200b05"],
  ["registration, short middle, Arabic-Indic", asScript("2098/12345/05", 0x660)], ["registration, four groups", "2098/123456/05/1"], ["ID, dotted", "800101.5009.087"],
  ["an ID spaced like a registration number", "8001 015009 08"], ["trust number", "IT 1234/2020"], ["CK without a number", "CK"], ["an older CIPC form", "CK2098/12345/05"],
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
    const registrations = TABLE.filter(([label]) => label.startsWith("registration") && !/other suffix|suffix 00|suffix 10|no suffix|short middle|padded middle|one-digit|7-digit|four groups|odd split|spaces only/.test(label)).map(([, value]) => value)
    for (const value of registrations) expect(await sqlKey(value), JSON.stringify(value)).toBe(REG)
  })

  it("reads a registration number's segments as written: the padding of the middle one is not significant, 2098/12345/05 is 2098/012345/05", async () => {
    const one = ["2098/12345/05", "2098/012345/05", "2098 / 12345 / 5", "CK 2098-12345-05", "2098_012345_05", "Reg 2098/12345/05", "2098/12345/05 (Pty)", "209801234505",
      "２０９８／１２３４５／０５", "2098\u200b12345\u200b05", asScript("2098/12345/05", 0x660)]
    for (const value of one) expect(await sqlKey(value), JSON.stringify(value)).toBe("20980123455")
    expect(await sqlKey("2098/1/05")).toBe("20980000015")
    expect(await sqlKey("2098 123456 05")).toBe(REG) // spaces are separators too
    expect(await sqlKey("20981234 5605")).toBe(REG) // an odd split is still the same twelve digits
    expect(await sqlKey("2098/12345/07")).toBe("20980123457")
    expect(await sqlKey("2098/1234567/05")).toBe("2098123456705") // not a registration number: its identifier key
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

    it("the segment-aware reading: the padding of the middle segment, the separators, a trailing label", async () => {
      const key = (value: string, without: Parameters<typeof attempt>[2]) => sqlKey(value, without)
      expect(await key("2098/12345/05", clauseOff("recoveryIdentifierKey", `lpad(registration[2], 6, '0')`, `registration[2]`))).not.toBe(await sqlKey("2098/012345/05"))
      expect(await key("2098/12345/05", clauseOff("recoveryIdentifierKey", `([0-9]{4})[^0-9A-Z]+([0-9]{1,6})`, `([0-9]{4})ZZ([0-9]{1,6})`))).not.toBe(await sqlKey("2098/012345/05"))
      expect(await key("2098/12345/05 (Pty)", clauseOff("recoveryIdentifierKey", `(?:[^0-9A-Z]*[A-Z]{1,8})?[^0-9A-Z]*$'`, `[^0-9A-Z]*$'`))).not.toBe("20980123455")
      expect(await key("Reg 2098/12345/05", clauseOff("recoveryIdentifierKey", `^[^0-9A-Z]*(?:[A-Z]{1,8}[^0-9A-Z]*)?([0-9]{4})`, `^[^0-9A-Z]*([0-9]{4})`))).not.toBe("20980123455")
    })

    it("the digit-run registration form: the suffix as a number, and the year, number and suffix split", async () => {
      const digitRun = `RETURN registration[1] || registration[2] || (registration[3]::INTEGER)::TEXT;`
      expect(await sqlKey("CK209812345605", clauseOff("recoveryIdentifierKey", digitRun, `RETURN registration[1] || registration[2] || registration[3];`))).not.toBe(REG)
      expect(await sqlKey("CK209812345605", clauseOff("recoveryIdentifierKey", `'^(?:CK)?([0-9]{4})([0-9]{6})([0-9]{1,2})$'`, `'^$'`))).not.toBe(REG)
    })
  })
})
