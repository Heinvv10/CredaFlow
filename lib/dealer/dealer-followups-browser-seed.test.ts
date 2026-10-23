/**
 * Local synthetic browser-acceptance seed for SLICE5-FOLLOWUPS.md part D
 * (consent v2, dealer draft cancel, draft purge); run explicitly on an owned
 * disposable database, never a shared one. How to run it:
 * docs/asset-finance/evidence/slice5-followups/browser/D/README.md.
 *
 * The dealer fixture's demo lender (portal on, dealers A and B), with: a draft
 * of A's sales user carrying a signed POPIA consent form (for the remote
 * attestation), a second draft of that user (to cancel), a draft abandoned 91
 * days ago (for the purge) and a booked deal of dealer A moved four years back
 * (untouched by the purge). Staff sign in with a password and TOTP, dealer
 * users with a password; the logins go to a local file (mode 600).
 */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { createDealerFixture } from "./dealer.integration-fixture"
import { actorOf, dealerDraft } from "./dealer-origination.integration-fixture"
import { bookedDealerDeal } from "./dealer-booking.integration-fixture"
import { age, storedDocument } from "./draft-purge.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const seed = process.env.DEALER_FOLLOWUPS_BROWSER_SEED === "1" ? it : it.skip
const OUT = process.env.DEALER_FOLLOWUPS_BROWSER_SEED_OUT || "/tmp/cf-dealer-followups-browser.json"
const PASSWORD = "Synthetic-Dealer-Followups-2026!"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

seed("seeds the synthetic part D browser acceptance on an owned disposable PG", async () => {
  const db = new PrismaClient()
  try {
    const token = `dlrfu${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const fx = await createDealerFixture(db, token)
    const hash = await bcrypt.hash(PASSWORD, 10)
    const staff = async (id: string) => db.user.update({ where: { id }, data: { password: hash, totpEnabled: true, totpSecret: TOTP_SECRET }, select: { email: true, role: true } })
    const dealer = async (id: string) => db.dealerUser.update({ where: { id }, data: { passwordHash: hash, name: "TEST Dealer User" }, select: { email: true, role: true } })
    const sales = actorOf(fx, fx.salesUserA, fx.dealerA)

    const consentDraft = await dealerDraft(fx, sales)
    storedDocument(fx, consentDraft.dealId)
    const cancelDraft = await dealerDraft(fx, sales)
    const abandoned = await dealerDraft(fx, sales)
    storedDocument(fx, abandoned.dealId)
    storedDocument(fx, abandoned.dealId, "BANK_STATEMENT")
    age(abandoned.dealId, 91)
    const booked = bookedDealerDeal(fx, fx.dealerA, fx.salesUserA)
    // The IT fixture's deal carries no structure; give it a real one so the staff deal page renders it.
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "AssetFinanceDeal" SET "structurePreset" = 'MONTHLY', "weights" = (SELECT jsonb_agg(1) FROM generate_series(1, 36))
      WHERE "id" = '${booked.dealId}'; COMMIT;`)
    age(booked.dealId, 4 * 366)

    const shape = {
      deals: (await db.assetFinanceDeal.findMany({ where: { tenantId: fx.tenantId }, select: { status: true } })).map((d) => d.status).sort(),
      documents: await db.entityDocument.count({ where: { tenantId: fx.tenantId } }),
      purges: await db.dealerDealPurge.count({ where: { tenantId: fx.tenantId } }),
    }
    expect(shape).toEqual({ deals: ["BOOKED", "DRAFT", "DRAFT", "DRAFT"], documents: 4, purges: 0 })

    writeFileSync(OUT, JSON.stringify({
      tenantId: fx.tenantId, slug: `af-deal-${token}`, password: PASSWORD, totpSecret: TOTP_SECRET,
      staff: { creditOfficer: await staff(fx.officer), loanAdmin: await staff(fx.adminA) },
      dealers: { salesA: await dealer(fx.salesUserA), adminA: await dealer(fx.adminUserA), adminB: await dealer(fx.userB) },
      deals: { consent: consentDraft, cancel: cancelDraft, abandoned, booked },
      shape,
    }, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 600_000)
