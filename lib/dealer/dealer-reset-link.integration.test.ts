/**
 * A staff "reset link" (issueDealerPasswordLink) ends the user's sessions AND
 * clears the old password, so whoever holds it cannot sign straight back in
 * before the user opens the new link (review finding S2, PR #216). A dealer
 * that has been deactivated gets no link at all (C6).
 *
 *   RUN_ASSET_FINANCE_DEALER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/dealer/dealer-reset-link.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupDealerFixtureIfCreated, createDealerFixture, insertDealer, insertDealerUser, lit, type DealerFixture } from "./dealer.integration-fixture"
import { authorizeDealer } from "./sign-in"
import { revalidateDealerPrincipal } from "./principal"
import { createDealerUser, deactivateDealer } from "./users"
import { issueDealerPasswordLink, setDealerPassword } from "./password-links"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_DEALER_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: DealerFixture
let host: string
const STOLEN = "TEST synthetic dealer passphrase 7"

const staffActor = () => ({ tenantId: fx.tenantId, userId: fx.adminA, userEmail: "admin-a@staff.invalid" })
const signIn = (email: string, password: string) => authorizeDealer({
  email, password, code: undefined,
  request: new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host } }),
  recordFailure: async () => undefined, equalizeTiming: async () => undefined,
})

suite.sequential("dealer reset link (real DB)", () => {
  beforeAll(async () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_DEALER_IT=1 is required")
    fx = await createDealerFixture(db, t)
    host = sql(`SELECT "domain" FROM "Tenant" WHERE "id" = ${lit(fx.tenantId)}`)
  }, 60_000)

  afterAll(() => cleanupDealerFixtureIfCreated(db, t))

  it("refuses the old password once staff issue a reset link, until the new link is used", async () => {
    const email = `${randomUUID().slice(0, 8)}@dealer.invalid`
    const created = await runWithTenant(fx.tenantId, () =>
      createDealerUser({ kind: "staff", staff: staffActor() }, fx.dealerA, { email, name: "TEST Dealer User", role: "DEALER_SALES" }))
    if (created.kind !== "created") throw new Error(created.error)
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: created.token, password: STOLEN })).toEqual({ kind: "set" })
    const before = await signIn(email, STOLEN)
    if (!before.ok) throw new Error("sign-in refused")

    const reset = await runWithTenant(fx.tenantId, () => issueDealerPasswordLink(staffActor(), fx.dealerA, created.userId))
    if (reset.kind !== "issued") throw new Error(reset.error)
    // The old session ends ...
    expect(await revalidateDealerPrincipal(before.user.id, before.user)).toBeNull()
    // ... and the old password mints no new one.
    expect((await signIn(email, STOLEN)).ok).toBe(false)
    expect(sql(`SELECT "passwordHash" IS NULL FROM "DealerUser" WHERE "id" = ${lit(created.userId)}`)).toBe("t")

    const fresh = "TEST synthetic new passphrase 8"
    expect(await setDealerPassword({ tenantId: fx.tenantId, token: reset.token, password: fresh })).toEqual({ kind: "set" })
    expect((await signIn(email, fresh)).ok).toBe(true)
  })

  it("issues no link for a user of a deactivated dealer", async () => {
    const dealerId = insertDealer(fx.tenantId, fx.adminA, { name: `TEST Reset ${randomUUID().slice(0, 8)}` })
    const userId = insertDealerUser(fx.tenantId, dealerId, { role: "DEALER_ADMIN", byUser: fx.adminA })
    // Deactivating a dealer revokes its users' sessions but leaves each user row active.
    expect((await runWithTenant(fx.tenantId, () => deactivateDealer(staffActor(), dealerId))).kind).toBe("deactivated")
    expect(await runWithTenant(fx.tenantId, () => issueDealerPasswordLink(staffActor(), dealerId, userId)))
      .toEqual({ kind: "refused", status: 409, error: "The dealer is deactivated" })
    expect(sql(`SELECT "setPasswordTokenHash" IS NULL FROM "DealerUser" WHERE "id" = ${lit(userId)}`)).toBe("t")
  })
})
