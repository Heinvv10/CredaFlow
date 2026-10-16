/**
 * Real-Postgres proof of migrations 20261016190100_selfie_link_portal_handoff
 * and 20261016190000_decline_internal_note (Fair Score audit 2026-10-16,
 * workstream D).
 *
 * A selfie capture link the signed-in client opens from the portal (channel
 * PORTAL) has no staff issuer; every other link keeps one
 * (SelfieCaptureToken_issuer_matches_channel). The decline categories gain
 * Fraud / Policy / Other and the application a staff-only decline note.
 *
 *   RUN_PORTAL_HANDOFF_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/selfie-link-portal-handoff.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { mintSelfieLinkToken } from "./selfie-link-token.server"

const RUN = process.env.RUN_PORTAL_HANDOFF_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const CONSTRAINT = "SelfieCaptureToken_issuer_matches_channel"
// A plain PrismaClient transaction, not the app's extended client the helper is typed for.
type MintDb = Parameters<typeof mintSelfieLinkToken>[0]

suite("portal selfie hand-off and decline note migrations", () => {
  let tenantId = ""
  let staffId = ""
  let clientId = ""
  let applicationId = ""

  beforeAll(async () => {
    const tenant = await db.tenant.create({ data: { slug: `pho-${token}`, name: "Portal hand-off IT" } })
    tenantId = tenant.id
    staffId = (await db.user.create({ data: {
      tenantId, email: `officer-${token}@test.invalid`, password: "synthetic", role: "CREDIT_OFFICER", active: true,
    } })).id
    clientId = (await db.client.create({ data: {
      tenantId, reference: `CLI-PHO-${token}`, idNumber: `PHO-${token}`, firstName: "Synthetic", lastName: "Handoff",
      email: `pho-${token}@test.invalid`, phone: "+27820000069",
    } })).id
    const product = await db.loanProduct.create({ data: {
      tenantId, code: `PHO-${token}`, name: "Synthetic Personal", productType: "PERSONAL",
      minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT",
    } })
    applicationId = (await db.loanApplication.create({ data: {
      tenantId, reference: `APP-PHO-${token}`, clientId, productId: product.id, appliedAmount: 500_000, appliedTermDays: 90,
    } })).id
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("has the issuer CHECK on SelfieCaptureToken", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT conrelid::regclass::text AS relname FROM pg_constraint WHERE contype = 'c' AND conname = $1`, CONSTRAINT,
    )
    expect(rows).toEqual([{ relname: `"SelfieCaptureToken"` }])
  })

  it("mints a PORTAL link with no staff issuer", async () => {
    const minted = await db.$transaction((tx) => mintSelfieLinkToken(tx as unknown as MintDb, {
      tenantId, applicationId, clientId, channel: "PORTAL", sentTo: "portal", createdById: null,
    }))
    const row = await db.selfieCaptureToken.findUniqueOrThrow({ where: { id: minted.id } })
    expect(row).toMatchObject({ channel: "PORTAL", createdById: null, usedAt: null, invalidatedAt: null })
  })

  it("still mints a staff link with its issuer, cancelling the earlier one", async () => {
    const minted = await db.$transaction((tx) => mintSelfieLinkToken(tx as unknown as MintDb, {
      tenantId, applicationId, clientId, channel: "WHATSAPP", sentTo: "+27820000069", createdById: staffId,
    }))
    const live = await db.selfieCaptureToken.findMany({ where: { tenantId, applicationId, usedAt: null, invalidatedAt: null } })
    expect(live.map((t) => t.id)).toEqual([minted.id])
  })

  it.each([
    ["a staff channel with no issuer", "SMS", null],
    ["a PORTAL link naming a staff issuer", "PORTAL", "staff"],
  ])("refuses %s", async (_label, channel, issuer) => {
    const write = db.$executeRawUnsafe(
      `INSERT INTO "SelfieCaptureToken" ("id","tenantId","applicationId","clientId","tokenHash","channel","sentTo","expiresAt","invalidatedAt","createdById")
       VALUES ($1, $2, $3, $4, $5, $6, 'x', now() + interval '1 day', now(), $7)`,
      `sct_${randomUUID().slice(0, 8)}`, tenantId, applicationId, clientId, randomUUID(), channel, issuer === "staff" ? staffId : null,
    )
    await expect(write).rejects.toThrow(CONSTRAINT)
  })

  it("has the new decline categories and the staff-only note column", async () => {
    const values = await db.$queryRawUnsafe<Array<{ v: string }>>(`SELECT unnest(enum_range(NULL::"DeclineCategory"))::text AS v`)
    expect(values.map((r) => r.v)).toEqual(expect.arrayContaining(["FRAUD", "POLICY", "OTHER"]))
    const columns = await db.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'LoanApplication' AND column_name = 'declineInternalNote'`,
    )
    expect(columns).toEqual([{ is_nullable: "YES" }])
  })
})
