/**
 * BREAK TEST 2 (RUN_ASSET_FINANCE_RECOVERY_IT): hide a related buyer from the related-party screening. Each case
 * proposes a sale at the valuation to a buyer who IS a related party, written in a variant; a correct system
 * flags it (relatedPartyMatch true). A red case is a reproduced FAIL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")

/** Proposes a sale (at the valuation) to this buyer on a fresh NON_NCA recovery and answers whether it was flagged. */
async function flagged(buyer: Record<string, unknown>, regime: "NON_NCA" | "NCA" = "NON_NCA", setup?: (loanId: string) => Promise<void>): Promise<{ flagged: boolean; status: number }> {
  const rec = await plainListed(db, fx, regime, 100_000_000)
  if (setup) await setup(rec.loan.loanId)
  officer()
  const out = await readJson(await bundle(fx).s.propose(rec.id, saleBody(rec.valuationId, 100_000_000, buyer)))
  return { status: out.status, flagged: out.body.relatedPartyMatch === true }
}

suite.sequential("break 2: hiding a related buyer", () => {
  let director: { idNumber: string; firstName: string; lastName: string }
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await makeTenant()
    director = await db.client.findUniqueOrThrow({ where: { id: fx.director }, select: { idNumber: true, firstName: true, lastName: true } })
    await db.user.update({ where: { id: fx.adminB }, data: { name: "Thandiwe Nkosi-Mokoena" } })
    await db.user.update({ where: { id: fx.officer }, data: { name: "Pieter van der Merwe" } })
  }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  const stranger = { buyerName: "Zzyzx Stranger", buyerIdentifier: "ZZ-STRANGER-1" }

  it("control: an unrelated buyer is not flagged; the exact director ID is", async () => {
    expect((await flagged(stranger)).flagged).toBe(false)
    expect((await flagged({ ...stranger, buyerIdentifier: director.idNumber })).flagged).toBe(true)
  }, 120_000)

  const id = () => director.idNumber
  const idVariants: [string, () => string][] = [
    ["ID with spaces", () => `${id().slice(0, 6)} ${id().slice(6, 10)} ${id().slice(10)}`],
    ["ID with dashes", () => `${id().slice(0, 6)}-${id().slice(6, 10)}-${id().slice(10)}`],
    ["ID lower-case/leading text 'ID:'", () => `id: ${id()}`],
    ["ID with trailing zero-width space", () => `${id()}​`],
    ["ID in fullwidth digits", () => [...id()].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("")],
    ["ID in Arabic-Indic digits", () => [...id()].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x630)).join("")],
    ["ID with a leading apostrophe and tab", () => `'\t${id()}`],
  ]
  for (const [label, make] of idVariants) {
    it(`2a. director ID, ${label}, unrelated name: flagged`, async () => {
      const out = await flagged({ buyerName: "Zzyzx Stranger", buyerIdentifier: make() })
      expect(out.flagged, `${label}: ${JSON.stringify(make())}`).toBe(true)
    }, 120_000)
  }

  it("2b. entity registration number formats of the borrower entity", async () => {
    const results: Record<string, boolean> = {}
    officer()
    const labels = ["exact", "no slashes", "spaces", "lowercase", "unpadded suffix (/5)", "CK prefix", "suffix dropped", "different suffix /07 (same company number)"]
    let n = 100000
    for (const label of labels) {
      const r = await plainListed(db, fx, "NON_NCA", 100_000_000)
      const reg = `2098/${n++}/05`
      const [y, num, suf] = reg.split("/")
      const value = ({
        exact: reg, "no slashes": `${y}${num}${suf}`, spaces: `${y} / ${num} / ${suf}`, lowercase: reg.toLowerCase(),
        "unpadded suffix (/5)": `${y}/${num}/${Number(suf)}`, "CK prefix": `CK${y}/${num}/${suf}`, "suffix dropped": `${y}/${num}`,
        "different suffix /07 (same company number)": `${y}/${num}/07`,
      } as Record<string, string>)[label]
      await db.$executeRawUnsafe(`UPDATE "BusinessEntity" SET "registrationNumber" = $1 WHERE "id" = $2`, reg, r.loan.entityId)
      const out = await readJson(await bundle(fx).s.propose(r.id, saleBody(r.valuationId, 100_000_000, { buyerType: "ENTITY", buyerName: "Zzyzx Holdings", buyerIdentifier: value })))
      results[label] = out.body.relatedPartyMatch === true
    }
    // Only formats that are the same registration number must be flagged.
    expect(results, JSON.stringify(results)).toMatchObject({ exact: true, "no slashes": true, spaces: true, lowercase: true, "unpadded suffix (/5)": true, "CK prefix": true })
  }, 240_000)

  const nameVariants: [string, () => Record<string, unknown>][] = [
    ["borrower's director, upper-case + extra spaces", () => ({ buyerName: `  ${director.firstName.toUpperCase()}   ${director.lastName.toUpperCase()} ` })],
    ["director surname first, no comma", () => ({ buyerName: `${director.lastName} ${director.firstName}` })],
    ["director surname first with comma", () => ({ buyerName: `${director.lastName}, ${director.firstName}` })],
    ["director with a middle initial", () => ({ buyerName: `${director.firstName} J ${director.lastName}` })],
    ["director with initial only", () => ({ buyerName: `T ${director.lastName}` })],
    ["director with diacritics", () => ({ buyerName: `${director.firstName.replace("E", "É")} ${director.lastName.replace("i", "í")}` })],
    ["director with hyphenated/no-space name", () => ({ buyerName: `${director.firstName}${director.lastName}` })],
    ["director via Mr title", () => ({ buyerName: `Mr ${director.firstName} ${director.lastName}` })],
    ["director name with trailing (Pty) Ltd entity buyer", () => ({ buyerType: "ENTITY", buyerName: `${director.firstName} ${director.lastName} Trading (Pty) Ltd` })],
  ]
  for (const [label, make] of nameVariants) {
    it(`2c. ${label} (stranger ID): flagged`, async () => {
      const out = await flagged({ buyerIdentifier: "ZZ-OTHER-ID-77", ...make() })
      expect(out.flagged, label).toBe(true)
    }, 120_000)
  }

  const staffVariants: [string, string][] = [
    ["staff member exact name", "Thandiwe Nkosi-Mokoena"],
    ["staff member name, hyphen as space", "Thandiwe Nkosi Mokoena"],
    ["staff member surname first", "Nkosi-Mokoena Thandiwe"],
    ["staff member surname first with comma", "Nkosi-Mokoena, Thandiwe"],
    ["staff member initial + surname", "T Nkosi-Mokoena"],
    ["staff member with ä", "Pieter van der Merwé"],
    ["staff member without 'van der' particle spacing", "Pieter vander Merwe"],
    ["staff member name case", "pieter VAN DER merwe"],
  ]
  for (const [label, name] of staffVariants) {
    it(`2d. ${label}: flagged`, async () => {
      const out = await flagged({ buyerName: name, buyerIdentifier: "ZZ-OTHER-ID-78" })
      expect(out.flagged || out.status === 409, `${label} (flagged, or refused as self-dealing for the acting officer)`).toBe(true)
    }, 120_000)
  }

  it("2e. an inactive surety of the borrower entity, by ID with punctuation", async () => {
    let n = 0
    const addSurety = (idNumber: string) => async (loanId: string) => {
      const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { entityId: true } })
      const surety = await db.client.create({ data: { tenantId: fx.tenantId, firstName: "Sipho", lastName: "Suretyman", email: `s${n}-${loanId}@client.invalid`, phone: `00${n++}${loanId.slice(-7)}`, idNumber, popiaConsentGiven: true } })
      await db.entityRelationship.create({ data: { tenantId: fx.tenantId, entityId: loan.entityId!, clientId: surety.id, role: "SURETY", active: false } })
    }
    expect((await flagged({ buyerName: "Zzyzx", buyerIdentifier: "ZZ-1" }, "NON_NCA", addSurety("8001015009087"))).flagged).toBe(false) // control
    expect((await flagged({ buyerName: "Sipho Suretyman", buyerIdentifier: "8001 0150 09087" }, "NON_NCA", addSurety("8101015009086"))).flagged, "inactive surety by name").toBe(true)
    expect((await flagged({ buyerName: "Zzyzx", buyerIdentifier: "8201 0150 0908-5" }, "NON_NCA", addSurety("8201015009085"))).flagged, "inactive surety by ID with punctuation").toBe(true)
  }, 120_000)

  it("2f. borrower entity name variants as an ENTITY buyer", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    const entity = (await db.loan.findUniqueOrThrow({ where: { id: rec.loan.loanId }, select: { entity: { select: { legalName: true } } } })).entity!.legalName
    const base = entity.replace(" (Pty) Ltd", "")
    officer()
    const results: Record<string, boolean> = {}
    for (const [label, name] of Object.entries({
      exact: entity, "Pty Ltd no parens": `${base} Pty Ltd`, "Proprietary Limited": `${base} (Proprietary) Limited`, "Proprietary Limited no parens": `${base} Proprietary Limited`,
      "no suffix": base, "upper": entity.toUpperCase(), "(PTY)LTD joined": `${base} (PTY)LTD`,
    })) {
      const r = await plainListed(db, fx, "NON_NCA", 100_000_000)
      await db.$executeRawUnsafe(`UPDATE "BusinessEntity" SET "legalName" = $1 WHERE "id" = $2`, entity, r.loan.entityId)
      const out = await readJson(await bundle(fx).s.propose(r.id, saleBody(r.valuationId, 100_000_000, { buyerType: "ENTITY", buyerName: name, buyerIdentifier: "ZZ-ENT-1" })))
      results[label] = out.body.relatedPartyMatch === true
    }
    expect(results, JSON.stringify(results)).toMatchObject({ exact: true, "Pty Ltd no parens": true, "Proprietary Limited": true, "no suffix": true })
  }, 240_000)
})
