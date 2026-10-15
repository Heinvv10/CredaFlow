/**
 * Slice 4a related-party forcing (migration 20261015400000), each proved as in
 * the lease suites: the trigger forces relatedPartyMatch on a sale whose buyer
 * carries the borrower's ID number, the borrowing company's registration
 * number or a related client's ID number, however it is punctuated or in
 * whatever digit script, and the same sale with that one clause of
 * recoveryBuyerRelated taken out keeps the flag false. The identifier key
 * itself is proved in recovery-rules-identifier.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-rules-sale-related.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { advance, saleData } from "./recovery-path.integration-fixture"
import {
  cleanupRecoveryFixture, courtMatter, createRecoveryFixture, newLoan, newRecovery, recoveryFixtureTenantId, type RecoveryFixture, type RecoveryLoan,
} from "./recovery.integration-fixture"
import { attempt } from "./lease-servicing.integration-fixture"
import { clauseOff, takeOut, type Tx } from "./recovery-rules.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
let fx: RecoveryFixture
interface Rec { loan: RecoveryLoan; id: string }
const R = {} as Record<"non" | "nca", Rec>
let directorId = ""

const saleIn = async (tx: Tx, rec: Rec, over: Record<string, unknown> = {}) =>
  tx.remarketingSale.create({ data: { ...(await saleData(database(), fx, rec.loan, rec.id)), ...over } as never })
const listed = async (regime: "NCA" | "NON_NCA"): Promise<Rec> => {
  const loan = await newLoan(database(), fx, regime)
  const id = await newRecovery(database(), fx, loan, regime === "NCA" ? "NCA_S131_ATTACHMENT" : "NON_NCA_VOLUNTARY", regime === "NCA" ? { legalMatterId: await courtMatter(database(), fx, loan) } : {})
  await advance(database(), fx, loan, id, "LISTED")
  return { loan, id }
}

/** What the trigger made of an insert, with the rules given taken out. */
async function forced(rec: Rec, buyerIdentifier: string, ...without: NonNullable<Parameters<typeof attempt>[2]>[]): Promise<boolean> {
  let seen: boolean | undefined
  const result = await attempt(database(), async (tx) => {
    for (const rule of without) await takeOut(tx, rule)
    seen = (await saleIn(tx, rec, { buyerIdentifier })).relatedPartyMatch
  })
  expect(result).toBe("ok")
  return seen as unknown as boolean
}

suite("slice 4a related-party forcing on a remarketing sale", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    directorId = (await database().client.findUniqueOrThrow({ where: { id: fx.director } })).idNumber
    R.non = await listed("NON_NCA")
    R.nca = await listed("NCA")
    // a CIPC-shaped registration number (the fixture's is not), so the registration forms below can be tried
    await database().businessEntity.update({ where: { id: R.non.loan.entityId as string }, data: { registrationNumber: "2098/123456/05" } })
    R.non.loan.borrowerKey = "2098/123456/05"
  }, 300_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  describe("related parties", () => {
    it("forces relatedPartyMatch for a buyer carrying the borrower's ID number, however it is punctuated", async () => {
      const spaced = R.nca.loan.borrowerKey.replace(/(\d{6})(\d{4})(\d{3})/, "$1 $2 $3")
      expect(await forced(R.nca, spaced)).toBe(true)
      expect(await forced(R.nca, spaced, clauseOff("recoveryBuyerRelated", `EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = loan_row."clientId" AND c."tenantId" = tenant_id AND public."recoveryIdentifierCandidates"(c."idNumber") && buyer_keys)`, "false"))).toBe(false)
    })

    it("forces it for a buyer carrying the borrowing company's registration number", async () => {
      const dashed = R.non.loan.borrowerKey.replaceAll("/", "-").toLowerCase()
      expect(await forced(R.non, dashed)).toBe(true)
      expect(await forced(R.non, dashed, clauseOff("recoveryBuyerRelated", `public."recoveryIdentifierCandidates"(b."registrationNumber") && buyer_keys`, "false"))).toBe(false)
    })

    it("forces it for a buyer carrying a related client's ID number (any role)", async () => {
      expect(await forced(R.non, directorId)).toBe(true)
      expect(await forced(R.non, directorId, clauseOff("recoveryBuyerRelated", `JOIN "Client" c ON c."id" = er."clientId" AND c."tenantId" = er."tenantId"`, `JOIN "Client" c ON c."id" = er."clientId" AND c."tenantId" = er."tenantId" AND false`))).toBe(false)
    })

    it("forces it across Unicode digit forms and registration number forms (fullwidth, Arabic-Indic, CK prefix, unpadded suffix)", async () => {
      const toScript = (digits: string, zero: number) => [...digits].map((c) => /\d/.test(c) ? String.fromCodePoint(zero + Number(c)) : c).join("")
      expect(await forced(R.nca, toScript(R.nca.loan.borrowerKey, 0xff10))).toBe(true)
      expect(await forced(R.nca, toScript(R.nca.loan.borrowerKey, 0x660))).toBe(true)
      expect(await forced(R.non, "CK2098/123456/5")).toBe(true)
      expect(await forced(R.non, toScript("2098123456 05", 0x6f0))).toBe(true)
      expect(await forced(R.non, "2098/123456/07")).toBe(false) // another suffix is another registration
    })

    it("forces it across the padding of a registration number's segments (2098/12345/05 is 2098/012345/05)", async () => {
      const set = (registrationNumber: string) => database().businessEntity.update({ where: { id: R.non.loan.entityId as string }, data: { registrationNumber } })
      await set("2098/012345/05")
      try {
        for (const written of ["2098/12345/05", "2098 / 12345 / 5", "CK 2098-12345-05", "209801234505", "Reg 2098/12345/05 (Pty)"]) {
          expect(await forced(R.non, written), written).toBe(true)
        }
        // the padding is in the canonical key and in the written-registration keys of the field
        const unpadded = clauseOff("recoveryIdentifierKey", `lpad(registration[2], 6, '0')`, `registration[2]`)
        const unpaddedField = clauseOff("recoveryIdentifierKeys", `lpad(written[2], 6, '0')`, `written[2]`)
        expect(await forced(R.non, "2098/12345/05", unpadded, unpaddedField)).toBe(false)
        expect(await forced(R.non, "2098/12345/07")).toBe(false) // another suffix
      } finally {
        await set("2098/123456/05")
      }
    })

    it("forces it when the known ID or registration number is hidden in a longer field (appended, prefixed, doubled, labelled, typed with O and l)", async () => {
      const id = R.nca.loan.borrowerKey
      const fields = [`${id}0`, `27${id}`, `7001015800084 / ${id}`, `${id.slice(0, 4)} ID ${id.slice(4)}`, id.replaceAll("0", "O").replaceAll("1", "l"), `RSA ${id} (SA ID)`]
      for (const field of fields) expect(await forced(R.nca, field), field).toBe(true)
      const direct = clauseOff("recoveryBuyerRelated", `c."id" = loan_row."clientId" AND c."tenantId" = tenant_id AND public."recoveryIdentifierCandidates"(c."idNumber") && buyer_keys`,
        `c."id" = loan_row."clientId" AND c."tenantId" = tenant_id AND public."recoveryIdentifierKey"(c."idNumber") = public."recoveryIdentifierKey"(identifier)`)
      for (const field of fields.slice(0, 5)) expect(await forced(R.nca, field, direct), field).toBe(false)
      expect(await forced(R.nca, id, direct)).toBe(true) // equality is kept
      expect(await forced(R.non, "our company is 2098/123456/05 (Pty) Ltd")).toBe(true)
      expect(await forced(R.non, `director ${directorId} signs`)).toBe(true)
      expect(await forced(R.nca, `${id.slice(0, 12)}8`)).toBe(false)
    })

    it("leaves a stranger alone", async () => {
      expect(await forced(R.non, "7001015800084")).toBe(false)
      expect(await forced(R.nca, "7001015800084")).toBe(false)
    })
  })
})
