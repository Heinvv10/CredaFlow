/**
 * Edge tester W (real Postgres): the dealer changes after the documents were issued.
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=... npx vitest run --no-file-parallelism <this file>
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"
import { insertDealer, insertDealerUser, lit } from "@/lib/dealer/dealer.integration-fixture"
import { dealFixtureTenantId } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { dealStartDate } from "../../deal-structure"
import { isoOfDbDate } from "../../dates"
import { loadDealDocumentData } from "../deal-document-data"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { renderDealDocument } from "../render"
import { pinnedIssuance } from "./issuance"
import { expectReproducibleIssuances } from "./templates.integration-fixture"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: SigningFixture
const database = (): PrismaClient => { if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required"); return db }
const appDb = () => database() as unknown as typeof import("@/lib/prisma").prisma
const NAME_A = "Société Générale Motors (edge)"
const NAME_B = "Müller & O'Brien Plant"
let dealerA = ""

const prepare = async () => {
  session.current = { user: { id: fx.officer, email: "officer@edge-w.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId } }
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { firstDueDate: true } })
  return signingRoutes(fx.host).prepare(fx.dealId, { plannedStartDate: dealStartDate(isoOfDbDate(deal.firstDueDate)) })
}
const current = () => database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: fx.dealId, document: "AGREEMENT", supersededAt: null } })
const textOf = async () => prose(await texts(await readFile((await current()).pdfStoragePath!))).replace(/\s+/g, " ")
const setDeal = (dealerId: string | null) => {
  const user = dealerId ? insertDealerUser(fx.tenantId, dealerId, { byUser: fx.adminA }) : null
  sql(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "AssetFinanceDeal" SET "dealerId" = ${dealerId ? lit(dealerId) : "NULL"},
    "dealerUserId" = ${user ? lit(user) : "NULL"}, "dealerSubmittedAt" = ${user ? "CURRENT_TIMESTAMP" : "NULL"}
    ${user ? `, "createdById" = ${lit(user)}` : ""} WHERE "id" = ${lit(fx.dealId)}; COMMIT;`)
}

/** What the portal e-sign path does: live data, but the pinned lender and introducer. Must equal the issued hash. */
async function signerSeesSameBytes(): Promise<void> {
  const issuance = await current()
  const data = await loadDealDocumentData(appDb(), fx.tenantId, fx.dealId)
  const pinned = await pinnedIssuance(appDb(), fx.tenantId, issuance.id)
  expect(data && pinned).toBeTruthy()
  const fresh = await renderDealDocument({ ...data!, lender: pinned!.lender, dealer: pinned!.dealer }, "AGREEMENT", "x", pinned!.wording)
  expect(fresh.sha256).toBe(issuance.pdfSha256)
}

suite.sequential("dealer changes after documents are issued (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createSigningFixture(database(), t, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@edge-w.test`, role, tenantId: dealFixtureTenantId(t) } }
    }, undefined, { templates: false })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { ...SYNTHETIC_IDENTITY, isDemoLender: true } })
    await ensureSyntheticTemplates(fx.tenantId, { adminOne: { id: fx.adminA, email: "a@x.invalid" }, adminTwo: { id: fx.adminB, email: "b@x.invalid" } })
    dealerA = insertDealer(fx.tenantId, fx.adminA, { name: NAME_A })
    setDeal(dealerA)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    const tenantId = lit(dealFixtureTenantId(t))
    sql(`BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM "DealerUser" WHERE "tenantId" = ${tenantId}; DELETE FROM "Dealer" WHERE "tenantId" = ${tenantId}; COMMIT;`)
    await cleanupSigningFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("prepare with a dealer (accented name) prints it and reproduces", async () => {
    const r = await prepare()
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await textOf()).toContain(`Introducer ${NAME_A} (dealer)`)
    await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)
    await signerSeesSameBytes()
  })

  it("renamed after issue: signer still sees the issued bytes, issued text keeps the old name", async () => {
    sql(`UPDATE "Dealer" SET "name" = ${lit(NAME_B)} WHERE "id" = ${lit(dealerA)}`)
    await signerSeesSameBytes()
    expect(await textOf()).toContain(NAME_A)
    await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)
  })

  it("deactivated after issue: same", async () => {
    sql(`UPDATE "Dealer" SET "active" = false, "deactivatedAt" = now(), "deactivatedById" = ${lit(fx.adminA)} WHERE "id" = ${lit(dealerA)}`)
    await signerSeesSameBytes()
  })

  it("renamed to an unprintable name after issue: signer unaffected, loader does not throw", async () => {
    sql(`UPDATE "Dealer" SET "name" = 'Ł' || chr(8203) || 'ódź' WHERE "id" = ${lit(dealerA)}`)
    await signerSeesSameBytes()
  })

  it("deal moved to no dealer after issue: signer unaffected; re-prepare prints no clause and supersedes", async () => {
    setDeal(null)
    await signerSeesSameBytes()
    const old = await current()
    const r = await prepare()
    expect(r.status, await r.clone().text()).toBe(200)
    expect((await current()).id).not.toBe(old.id)
    expect(await textOf()).not.toContain("Introducer")
    await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)
  })

  it("deal moved to a different, deactivated dealer: re-prepare names that dealer (inactive does not matter to print)", async () => {
    const b = insertDealer(fx.tenantId, fx.adminA, { name: NAME_B })
    sql(`UPDATE "Dealer" SET "active" = false, "deactivatedAt" = now(), "deactivatedById" = ${lit(fx.adminA)} WHERE "id" = ${lit(b)}`)
    setDeal(b)
    const r = await prepare()
    expect(r.status, await r.clone().text()).toBe(200)
    expect(await textOf()).toContain(`Introducer ${NAME_B} (dealer)`)
    await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)
    await signerSeesSameBytes()
  })

  it("dealer row deleted while deal still points at it is refused by the database (FK)", async () => {
    const id = (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { dealerId: true } })).dealerId!
    expect(() => sql(`DELETE FROM "Dealer" WHERE "id" = ${lit(id)}`)).toThrow()
  })
})
