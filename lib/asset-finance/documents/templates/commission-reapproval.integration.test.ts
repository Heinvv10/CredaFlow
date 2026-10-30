/**
 * Real-Postgres proof of the commission disclosure's release (slice 5
 * follow-ups part W): a demo lender whose templates were approved at
 * SYSTEM_REVISION 2026-10-19.1 has exactly the variants that now print the
 * disclosure lapse (documents refuse to issue), `ensureSyntheticTemplates`
 * approves those again with the lender's wording untouched (and the three
 * variants that print nothing new keep their approval), and documents issue
 * again: without the clause on a deal with no dealer, with it, and with every
 * figure the same, on a deal a dealer introduced. The issuance's retained input
 * reproduces the PDF in both cases.
 *
 *   RUN_ASSET_TEMPLATES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/asset-finance/documents/templates/commission-reapproval.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { insertDealer, insertDealerUser, lit } from "@/lib/dealer/dealer.integration-fixture"
import { ensureSyntheticTemplates } from "@/prisma/seed/asset-finance-templates"
import { dealFixtureTenantId } from "../../deal.integration-fixture"
import { cleanupSigningFixture, createSigningFixture, signingRoutes, SYNTHETIC_IDENTITY, type SigningFixture } from "../../deal-signing.integration-fixture"
import { plannedStartFor } from "../../first-due.test-helpers"
import { isoOfDbDate } from "../../dates"
import { ISA_CLAUSE } from "../commission-disclosure.test-helpers"
import { prose, texts } from "../nca/nca-wording.test-helpers"
import { SYNTHETIC_DEMO_WATERMARK } from "../pdf-layout"
import { ALL_TEMPLATE_KEYS, ASSET_TEMPLATE_FAMILIES, SYSTEM_REVISION } from "./families"
import { systemFingerprint } from "./fingerprint"
import { selectIssuableTemplate } from "./issuance"
import { adoptStarter } from "./store"
import { expectReproducibleIssuances } from "./templates.integration-fixture"
import { latest, templateOf } from "./templates-it.helpers"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_TEMPLATES_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: SigningFixture

/** Every variant's fingerprint at SYSTEM_REVISION 2026-10-19.1, the release before the disclosure. */
const PRE_DISCLOSURE: Record<string, string> = {
  "af.isa.commercial": "99337242e1014e6e62265185e669b1604b0183f453b463c97533a697621f2910",
  "af.isa.cpa": "ebe0d4c172fd638bca5073e05d47994761966fb927c2d58b3f6732636c909cec",
  "af.lease.operating.commercial": "a192a558e661f9ae482b0924a0c8569df4b3a97fe176d81588faecdab26f0814",
  "af.lease.operating.cpa": "ed970f47d9aa03d50d3a4e75ed6ff2847ee067e6a0e4e631247534227c064c55",
  "af.lease.fml.commercial": "45434a91e63b681cbbfe6f8f434cdabf7be5d589445c81f03b93b9886b17a596",
  "af.lease.fml.cpa": "59323cd3efe744ef69a4372a6368d450f91f5c11c166e2471d7abad648f5e73e",
  "af.nca.instalment_sale": "edb5b49d88cb547eb8f105972a9b619f14c58e490fdf0c2b1225a820ae2e75bb",
  "af.nca.finance_lease": "c868e66750d2a71489b4f819f6fa69550690f9df71cd7f731735774bfb72cff2",
  "af.suretyship.commercial": "3075411b27f65252533ecefe9ba33bd534370ad2e219057359387df408ff2568",
  "af.suretyship.nca": "512b350acdd4189f62c56148bc7a931ba083e44b7b8bc436cad389515a76632d",
  "af.resolution.standard": "17f7807d1a724c350c7ad903ade3dabac1fbd65739ddb082859bccdc547fcba6",
}
const UNCHANGED = ["af.suretyship.commercial", "af.suretyship.nca", "af.resolution.standard"]
const MOVED = ALL_TEMPLATE_KEYS.filter((key) => !UNCHANGED.includes(key))
const DEALER_NAME = "TEST Dealer Motors (synthetic)"
const MONEY = /R\s?-?[\d,]+\.\d{2}/g

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_TEMPLATES_IT=1 is required")
  return db
}
const appDb = () => database() as unknown as typeof import("@/lib/prisma").prisma
const staff = () => ({ adminOne: { id: fx.adminA, email: "a@x.invalid" }, adminTwo: { id: fx.adminB, email: "b@x.invalid" } })
const prepare = async () => {
  session.current = { user: { id: fx.officer, email: "officer@templates-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId } }
  const deal = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { firstDueDate: true } })
  return signingRoutes(fx.host).prepare(fx.dealId, { plannedStartDate: plannedStartFor(isoOfDbDate(deal.firstDueDate)) })
}
const agreementText = async () => {
  const issuance = await database().assetDocumentIssuance.findFirstOrThrow({ where: { dealId: fx.dealId, document: "AGREEMENT", supersededAt: null } })
  const lines = await texts(await readFile(issuance.pdfStoragePath!))
  return { lines, text: prose(lines).replace(/\s+/g, " "), issuance }
}

suite.sequential("the commission disclosure's release: demo templates lapse and are approved again (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    fx = await createSigningFixture(database(), t, (userId, role) => {
      session.current = { user: { id: userId, email: `${userId}@templates-it.test`, role, tenantId: dealFixtureTenantId(t) } }
    }, undefined, { templates: false })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { ...SYNTHETIC_IDENTITY, isDemoLender: true } })
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    const tenantId = lit(dealFixtureTenantId(t))
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      DELETE FROM "DealerUser" WHERE "tenantId" = ${tenantId}; DELETE FROM "Dealer" WHERE "tenantId" = ${tenantId}; COMMIT;`)
    await cleanupSigningFixture(db, fx ?? { tenantId: dealFixtureTenantId(t) })
    await db.$disconnect()
  })

  it("exactly the variants that print the disclosure change fingerprint; the suretyships and the resolution do not", async () => {
    expect(SYSTEM_REVISION).toBe("2026-10-22.1")
    for (const key of ALL_TEMPLATE_KEYS) {
      const same = (await systemFingerprint(key)) === PRE_DISCLOSURE[key]
      expect(same, key).toBe(UNCHANGED.includes(key))
    }
  })

  it("approvals given at the previous revision lapse for the eight variants, and no document can be issued", async () => {
    for (const { family } of ASSET_TEMPLATE_FAMILIES) {
      const adopted = await adoptStarter({ tenantId: fx.tenantId, userId: fx.adminA, totpVerified: true }, family)
      expect(adopted.ok).toBe(true)
    }
    // As if approved and published before this release: the previous fingerprint (written past the store, which approves only the current one).
    for (const key of ALL_TEMPLATE_KEYS) {
      const template = await templateOf(database(), fx.tenantId, key)
      const draft = await latest(database(), template.id)
      await database().documentTemplateVersion.update({ where: { id: draft.id }, data: {
        approvedById: fx.adminB, approvedAt: new Date(), approvalBasis: "SYNTHETIC_DEMO", approvedContentSha256: draft.contentSha256, approvedSystemSha256: PRE_DISCLOSURE[key],
      } })
      await database().$transaction([
        database().documentTemplateVersion.update({ where: { id: draft.id }, data: { status: "ACTIVE", activatedById: fx.adminA, activatedAt: new Date() } }),
        database().documentTemplate.update({ where: { id: template.id }, data: { currentVersionId: draft.id } }),
      ])
    }
    for (const key of MOVED) await expect(selectIssuableTemplate(appDb(), fx.tenantId, key), key).rejects.toThrow(/changed after your approval/)
    for (const key of UNCHANGED) expect((await selectIssuableTemplate(appDb(), fx.tenantId, key)).approvalBasis, key).toBe("SYNTHETIC_DEMO")
    const refused = await prepare()
    expect(refused.status).toBe(422)
    expect((await refused.json()).error).toMatch(/changed after your approval/)
    expect(await database().assetDocumentIssuance.count({ where: { dealId: fx.dealId } })).toBe(0)
  })

  it("ensureSyntheticTemplates approves the eight lapsed variants again with the same wording, leaves the three others alone, and is idempotent", async () => {
    const before = new Map<string, { id: string; content: string | null }>()
    for (const key of ALL_TEMPLATE_KEYS) {
      const template = await templateOf(database(), fx.tenantId, key)
      before.set(key, { id: template.currentVersionId!, content: (await latest(database(), template.id)).content })
    }
    await ensureSyntheticTemplates(fx.tenantId, staff())
    await ensureSyntheticTemplates(fx.tenantId, staff())
    for (const key of ALL_TEMPLATE_KEYS) {
      const template = await templateOf(database(), fx.tenantId, key)
      const now = await latest(database(), template.id)
      const was = before.get(key)!
      if (UNCHANGED.includes(key)) {
        expect(now.id, key).toBe(was.id)
        expect(now.version, key).toBe(1)
      } else {
        expect(now, key).toMatchObject({ version: 2, status: "ACTIVE", approvalBasis: "SYNTHETIC_DEMO", content: was.content, approvedSystemSha256: await systemFingerprint(key) })
      }
      expect((await selectIssuableTemplate(appDb(), fx.tenantId, key)).approvalBasis, key).toBe("SYNTHETIC_DEMO")
    }
    expect(await database().documentTemplateVersion.count({ where: { template: { tenantId: fx.tenantId } } })).toBe(ALL_TEMPLATE_KEYS.length + MOVED.length)
  })

  it("documents issue again, under the demo mark, without the clause on a deal with no dealer", async () => {
    const response = await prepare()
    expect(response.status, await response.clone().text()).toBe(200)
    const { lines, text, issuance } = await agreementText()
    expect(lines).toContain(SYNTHETIC_DEMO_WATERMARK)
    expect(issuance).toMatchObject({ approvalBasis: "SYNTHETIC_DEMO", systemRevision: SYSTEM_REVISION })
    expect(text).not.toContain("Introducer")
    expect(await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)).toHaveLength(5)
  })

  it("a deal a dealer introduced prints the clause naming the dealer, moves no figure, and its retained input reproduces the PDF", async () => {
    const without = await agreementText()
    const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: DEALER_NAME })
    const dealerUserId = insertDealerUser(fx.tenantId, dealerId, { byUser: fx.adminA })
    // History, as the dealer fixtures write it: the hand-over a dealer deal has had by now.
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "AssetFinanceDeal" SET "dealerId" = ${lit(dealerId)}, "dealerUserId" = ${lit(dealerUserId)}, "createdById" = ${lit(dealerUserId)},
        "dealerSubmittedAt" = CURRENT_TIMESTAMP WHERE "id" = ${lit(fx.dealId)}; COMMIT;`)
    const response = await prepare()
    expect(response.status, await response.clone().text()).toBe(200)
    const withDealer = await agreementText()
    expect(withDealer.issuance.id).not.toBe(without.issuance.id)
    expect(withDealer.text).toContain(`Introducer ${DEALER_NAME} (dealer) ${ISA_CLAUSE}`)
    expect(withDealer.text.match(MONEY)).toEqual(without.text.match(MONEY))
    expect(withDealer.text.match(MONEY)?.length).toBeGreaterThan(20)
    expect(await expectReproducibleIssuances(database(), fx.tenantId, fx.dealId)).toHaveLength(5)
    // Resolution and suretyships are not pricing documents: no clause.
    const others = await database().assetDocumentIssuance.findMany({ where: { dealId: fx.dealId, supersededAt: null, document: { not: "AGREEMENT" } } })
    for (const other of others) expect(prose(await texts(await readFile(other.pdfStoragePath!))), other.templateKey).not.toContain("Introducer")
  })

  it("a dealer name written before the shape rule is refused at preparation: nothing is issued or superseded", async () => {
    const before = await agreementText()
    const { dealerId } = await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealId }, select: { dealerId: true } })
    sql(`UPDATE "Dealer" SET "name" = 'Mo' || chr(173) || 'tors' WHERE "id" = ${lit(dealerId)}`)
    try {
      const refused = await prepare()
      expect(refused.status).toBe(422)
      expect((await refused.json()).error).toMatch(/cannot be printed on the document/)
      expect((await agreementText()).issuance.id).toBe(before.issuance.id)
    } finally {
      sql(`UPDATE "Dealer" SET "name" = ${lit(DEALER_NAME)} WHERE "id" = ${lit(dealerId)}`)
    }
    expect((await prepare()).status).toBe(200)
  })
})
