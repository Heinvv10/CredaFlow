/**
 * Real-Postgres proof of the Xero push: one push per batch (claim before
 * send), an unknown outcome waits for a person, and two pushes needing a
 * token refresh spend the rotating refresh token once. fetch is stubbed:
 * nothing here reaches Xero.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/xero/xero.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { sealSecret, openSecret } from "@/lib/crypto/secret-box"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { closePeriod } from "../generate"
import { completeXeroConnect, disconnectXero, startXeroConnect, xeroAccessToken } from "./connection"
import { markStalePush, pushBatchToXero } from "./push"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const KEY = randomBytes(32).toString("base64")
const actor = { id: "", email: "xero-it@test.invalid" }
let tenantId = ""
let batchId = ""

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

async function connect(expiresAt: Date) {
  await db.xeroConnection.upsert({
    where: { tenantId },
    create: { tenantId, status: "CONNECTED", xeroTenantId: "org-1", xeroTenantName: "Demo Org", accessTokenSealed: sealSecret("at-0", KEY), refreshTokenSealed: sealSecret("rt-0", KEY), accessTokenExpiresAt: expiresAt },
    update: { status: "CONNECTED", xeroTenantId: "org-1", xeroTenantName: "Demo Org", accessTokenSealed: sealSecret("at-0", KEY), refreshTokenSealed: sealSecret("rt-0", KEY), accessTokenExpiresAt: expiresAt },
  })
}

suite.sequential("Xero push (real Postgres, stubbed fetch)", () => {
  beforeAll(async () => {
    vi.stubEnv("WABA_ENC_KEY", KEY)
    vi.stubEnv("XERO_CLIENT_ID", "client-it")
    vi.stubEnv("XERO_REDIRECT_URI", "https://lender.example/api/integrations/xero/callback")
    const ids = await createChargesLoan(db, await createChargesTenant(db, false))
    tenantId = ids.tenantId
    actor.id = ids.userId
    await db.accountingSettings.create({ data: { tenantId, goLiveMonth: "2026-08", mappingConfirmedAt: new Date() } })
    const out = await runWithTenant(tenantId, () => closePeriod(prisma, { tenantId, periodKey: "2026-08", userId: ids.userId, userEmail: actor.email, now: new Date("2026-11-01T00:00:00Z") }))
    batchId = out.batchId
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await db.$disconnect()
  })

  it("connects through PKCE: the state is this admin's, fresh and single-use; tokens land sealed", async () => {
    const url = new URL(await startXeroConnect(prisma, { tenantId, userId: actor.id }))
    const state = url.searchParams.get("state")!
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(200, { access_token: "at-c", refresh_token: "rt-c", expires_in: 1800 }))
      .mockResolvedValueOnce(json(200, [{ id: "conn-1", tenantId: "org-1", tenantName: "Demo Org", tenantType: "ORGANISATION" }]))
    await expect(completeXeroConnect(prisma, { tenantId, userId: "someone-else", state, code: "c" }, { fetch })).rejects.toThrow(/not valid here or has expired/)
    await expect(completeXeroConnect(prisma, { tenantId, userId: actor.id, state, code: "c", now: new Date(Date.now() + 11 * 60_000) }, { fetch })).rejects.toThrow(/expired/)
    const out = await completeXeroConnect(prisma, { tenantId, userId: actor.id, state, code: "c" }, { fetch })
    expect(out).toMatchObject({ status: "CONNECTED", organisation: { tenantId: "org-1" } })
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URLSearchParams(String(init.body)).get("code_verifier")).toBeTruthy()
    await expect(completeXeroConnect(prisma, { tenantId, userId: actor.id, state, code: "c" }, { fetch })).rejects.toThrow(/not valid here/)
    const row = await db.xeroConnection.findUniqueOrThrow({ where: { tenantId } })
    expect(row).toMatchObject({ status: "CONNECTED", xeroTenantId: "org-1", authState: null, authVerifierSealed: null })
    expect(row.accessTokenSealed).not.toContain("at-c")
    const cleanup = vi.fn(async () => new Response(null, { status: 200 }))
    expect(await disconnectXero(prisma, { tenantId }, { fetch: cleanup })).toEqual({ remoteCleanup: true })
    expect(await db.xeroConnection.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({ status: "DISCONNECTED", accessTokenSealed: null, refreshTokenSealed: null })
  })

  it("refreshes an expired token once when two callers race, and stores the rotated pair sealed", async () => {
    await connect(new Date("2020-01-01T00:00:00Z"))
    const fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50))
      return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 })
    })
    const [a, b] = await Promise.all([xeroAccessToken(prisma, tenantId, { fetch }), xeroAccessToken(prisma, tenantId, { fetch })])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect([a.accessToken, b.accessToken]).toEqual(["at-1", "at-1"])
    const row = await db.xeroConnection.findUniqueOrThrow({ where: { tenantId } })
    expect(row.refreshTokenSealed).not.toContain("rt-1")
    expect(openSecret(row.refreshTokenSealed!, KEY)).toBe("rt-1")
  })

  it("marks the connection NEEDS_RECONNECT when Xero refuses to refresh, and pushes nothing", async () => {
    await connect(new Date("2020-01-01T00:00:00Z"))
    const fetch = vi.fn(async () => json(400, { error: "invalid_grant" }))
    await expect(xeroAccessToken(prisma, tenantId, { fetch })).rejects.toMatchObject({ kind: "auth" })
    expect(await db.xeroConnection.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({ status: "NEEDS_RECONNECT", accessTokenSealed: null })
    const push = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId, actor }, { fetch }))
    expect(push.ok).toBe(false)
  })

  it("refuses to push while the Bank role has its default code, or a month closed with it", async () => {
    await connect(new Date(Date.now() + 3_600_000))
    const fetch = vi.fn()
    const unmapped = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId, actor }, { fetch }))
    expect(unmapped).toMatchObject({ ok: false, httpStatus: 422, error: expect.stringContaining("Map the Bank role") })
    await db.accountingAccountMapping.create({ data: { tenantId, role: "BANK", accountCode: "1090", accountName: "Loan clearing" } })
    const closedWithDefault = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId, actor }, { fetch }))
    expect(closedWithDefault).toMatchObject({ ok: false, httpStatus: 422, error: expect.stringContaining("by hand") })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("pushes a closed month once, tax-free and balanced; a second push is refused without calling Xero", async () => {
    await connect(new Date(Date.now() + 3_600_000))
    await createChargesLoan(db, { tenantId, userId: actor.id, productId: (await db.loanProduct.findFirstOrThrow({ where: { tenantId } })).id })
    const sep = await runWithTenant(tenantId, () => closePeriod(prisma, { tenantId, periodKey: "2026-09", userId: actor.id, userEmail: actor.email, now: new Date("2026-11-01T00:00:00Z") }))
    const fetch = vi.fn(async () => json(200, { ManualJournals: [{ ManualJournalID: "mj-1" }] }))
    const first = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId: sep.batchId, actor }, { fetch }))
    expect(first).toEqual({ ok: true, status: "PUSHED", manualJournalId: "mj-1" })
    const second = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId: sep.batchId, actor }, { fetch }))
    expect(second).toMatchObject({ ok: false, httpStatus: 409 })
    expect(fetch).toHaveBeenCalledTimes(1)
    const journal = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).ManualJournals[0]
    expect(journal.LineAmountTypes).toBe("NoTax")
    // The second loan's August disbursement lands late in September, on the mapped clearing account.
    expect(journal.JournalLines.map((l: { AccountCode: string; LineAmount: number }) => [l.AccountCode, l.LineAmount])).toEqual([
      ["1090", -2000], ["1100", 2338], ["4000", -200], ["4010", -138],
    ])
    expect(await db.accountingXeroPush.findUniqueOrThrow({ where: { batchId: sep.batchId } })).toMatchObject({ status: "PUSHED", xeroManualJournalId: "mj-1" })
    await expect(db.accountingXeroPush.update({ where: { batchId: sep.batchId }, data: { status: "SENDING" } })).rejects.toThrow(/PUSHED -> SENDING is not allowed/)
  })

  it("parks an unknown outcome for review and never re-sends it", async () => {
    await createChargesLoan(db, { tenantId, userId: actor.id, productId: (await db.loanProduct.findFirstOrThrow({ where: { tenantId } })).id })
    const oct = await runWithTenant(tenantId, () => closePeriod(prisma, { tenantId, periodKey: "2026-10", userId: actor.id, userEmail: actor.email, now: new Date("2026-11-01T00:00:00Z") }))
    const fetch = vi.fn(async () => json(503, {}))
    const out = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId: oct.batchId, actor }, { fetch }))
    expect(out).toMatchObject({ ok: false, status: "NEEDS_REVIEW" })
    const again = await runWithTenant(tenantId, () => pushBatchToXero(prisma, { tenantId, batchId: oct.batchId, actor }, { fetch }))
    expect(again).toMatchObject({ ok: false, httpStatus: 409 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("moves a push stuck SENDING for 10 minutes to review instead of resending", async () => {
    const nov = await runWithTenant(tenantId, () => closePeriod(prisma, { tenantId, periodKey: "2026-11", userId: actor.id, userEmail: actor.email, now: new Date("2026-12-02T00:00:00Z") }))
    await db.accountingXeroPush.create({ data: { tenantId, batchId: nov.batchId, status: "SENDING", xeroTenantId: "org-1", pushedById: actor.id } })
    expect(await markStalePush(prisma, { tenantId, batchId: nov.batchId, actor })).toBe(false)
    expect(await markStalePush(prisma, { tenantId, batchId: nov.batchId, actor, now: new Date(Date.now() + 11 * 60_000) })).toBe(true)
    expect(await db.accountingXeroPush.findUniqueOrThrow({ where: { batchId: nov.batchId } })).toMatchObject({ status: "NEEDS_REVIEW" })
  })

  it("pushes a month whose Bank mapping was stored before close, even on code 1000 (the stored mapping decides, not the literal)", async () => {
    const ids = await createChargesLoan(db, await createChargesTenant(db, false))
    const t = ids.tenantId
    await db.accountingAccountMapping.create({ data: { tenantId: t, role: "BANK", accountCode: "1000", accountName: "Loan clearing (code 1000)" } })
    await db.accountingSettings.create({ data: { tenantId: t, goLiveMonth: "2026-08", mappingConfirmedAt: new Date() } })
    const aug = await runWithTenant(t, () => closePeriod(prisma, { tenantId: t, periodKey: "2026-08", userId: ids.userId, userEmail: actor.email, now: new Date("2026-11-01T00:00:00Z") }))
    await db.xeroConnection.create({ data: { tenantId: t, status: "CONNECTED", xeroTenantId: "org-2", xeroTenantName: "Org 2", accessTokenSealed: sealSecret("at-x", KEY), refreshTokenSealed: sealSecret("rt-x", KEY), accessTokenExpiresAt: new Date(Date.now() + 3_600_000) } })
    const fetch = vi.fn(async () => json(200, { ManualJournals: [{ ManualJournalID: "mj-1000" }] }))
    const out = await runWithTenant(t, () => pushBatchToXero(prisma, { tenantId: t, batchId: aug.batchId, actor: { id: ids.userId, email: actor.email } }, { fetch }))
    expect(out).toEqual({ ok: true, status: "PUSHED", manualJournalId: "mj-1000" })
  })
})
