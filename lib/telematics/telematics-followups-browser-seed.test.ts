/**
 * Local synthetic browser-acceptance seed for docs/asset-finance/
 * SLICE5-FOLLOWUPS.md part T; run explicitly on an owned disposable
 * database, never a shared one. How to run it:
 * docs/asset-finance/evidence/slice5-followups/browser/T/README.md.
 *
 * A demo lender with:
 * - an operating lease in good standing (ACTIVE) with SIM-STEADY-0001, polled
 *   to today: positions to reveal under a theft report, and a trail;
 * - an operating lease with SIM-SPIKE-0002, polled to day 10 only: its
 *   50 000 h spike was held and then accepted by mistake (by the credit
 *   officer, here), so the excess projection is wildly high: the reading to void;
 * - an instalment sale with SIM-STEADY-0003, to settle in the browser: its
 *   tracker closure follows.
 * The borrower's director has a portal login and an email Contact; the lender's
 * email goes to a local capture SMTP server (127.0.0.1, see the README), so
 * nothing leaves the machine. Staff sign in with a password and TOTP; the
 * logins go to a local file (mode 600). Every value is synthetic.
 */
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { expect, it, vi } from "vitest"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import { acceptHeldReading } from "./held-readings"
import { pollTenant } from "./poll"
import { bookInstalmentSale, bookOperatingLease, createTelematicsFixture, eveningOf, installDevice, loanStartDate } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const seed = process.env.TELEMATICS_FOLLOWUPS_BROWSER_SEED === "1" ? it : it.skip
const OUT = process.env.TELEMATICS_FOLLOWUPS_BROWSER_SEED_OUT || "/tmp/cf-telematics-followups-browser.json"
const SMTP_PORT = Number(process.env.TELEMATICS_FOLLOWUPS_SMTP_PORT || "2526")
const PASSWORD = "Synthetic-Telematics-Followups-2026!"
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

seed("seeds the synthetic part T browser acceptance on an owned disposable PG", async () => {
  const db = new PrismaClient()
  try {
    process.env.TRUSTED_PROXY = "1"
    const token = `telfu${randomUUID().replaceAll("-", "").slice(0, 8)}`
    const fx = await createTelematicsFixture(db, token)
    const setSession = (user: SessionUser | null) => { session.current = user && { user } }
    await db.loanProduct.update({ where: { id: fx.product }, data: { name: "TEST plant finance" } })

    const loans = {
      theft: await bookOperatingLease(db, fx, setSession, fx.assets[1], 30),
      spike: await bookOperatingLease(db, fx, setSession, fx.assets[2], 30),
      settle: await bookInstalmentSale(db, fx, setSession, fx.assets[3], 30),
    }
    const installedOn = await loanStartDate(db, loans.theft)
    const devices = {
      theft: await installDevice(fx, fx.assets[1], "SIM-STEADY-0001", installedOn),
      spike: await installDevice(fx, fx.assets[2], "SIM-SPIKE-0002", installedOn),
      settle: await installDevice(fx, fx.assets[3], "SIM-STEADY-0003", installedOn),
    }
    // Polled to day 10's evening: the spike is held, nothing after it is read yet.
    const day10 = fromDayNumber(toDayNumber(installedOn) + 10)
    expect(await pollTenant(fx.tenantId, new Date(eveningOf(day10).getTime() + 3_600_000))).toMatchObject({ ok: true, failed: 0 })
    const held = await db.telematicsHeldReading.findFirstOrThrow({ where: { tenantId: fx.tenantId, loanId: loans.spike, status: "HELD" }, orderBy: { value: "desc" } })
    expect(held.value).toBeGreaterThan(50_000)
    // Accepted by mistake: the wrong TELEMATICS reading staff will void.
    const accepted = await acceptHeldReading({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }, held.id, { note: "Checked on site (synthetic: the acceptance's mistake)" })
    expect(accepted).toMatchObject({ kind: "ok" })
    // The rest polled to now: the theft lease's positions; the spike lease's later (lower) readings are held behind the wrong one.
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true })

    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { isDemoLender: true } })
    await seedDefaultMessageTemplates(db, fx.tenantId, "TEST lender")
    // The lender's email: a local capture server, never a real one (README).
    await db.emailConfig.create({ data: {
      tenantId: fx.tenantId, provider: "IMAP_SMTP", fromName: "TEST lender", fromAddress: "lender@synthetic.invalid",
      smtpHost: "127.0.0.1", smtpPort: SMTP_PORT, smtpUser: "synthetic", smtpPass: "synthetic", useTls: false, active: true,
    } })
    const director = await db.client.update({ where: { id: fx.director }, data: { portalPassword: await bcrypt.hash(PASSWORD, 10) }, select: { id: true, email: true } })
    const contact = await db.contact.create({ data: { tenantId: fx.tenantId, clientId: director.id, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "synthetic-telematics-followups" } })
    await db.contactIdentity.create({ data: { tenantId: fx.tenantId, contactId: contact.id, channel: "EMAIL", source: "MANUAL", value: director.email.toLowerCase() } })

    const hash = await bcrypt.hash(PASSWORD, 10)
    const staffLogin = async (id: string) => (await db.user.update({ where: { id }, data: { password: hash, totpEnabled: true, totpSecret: TOTP_SECRET }, select: { email: true, role: true } }))
    const newStaff = async (label: string, role: "COLLECTIONS_OFFICER" | "READONLY") =>
      (await db.user.create({ data: { tenantId: fx.tenantId, email: `${label}-${token}@staff.invalid`, name: `TEST ${label}`, password: hash, role, totpEnabled: true, totpSecret: TOTP_SECRET } })).id
    const staff = {
      loanAdmin: await staffLogin(fx.adminA),
      creditOfficer: await staffLogin(fx.officer),
      collections: await staffLogin(await newStaff("collections", "COLLECTIONS_OFFICER")),
      readonly: await staffLogin(await newStaff("readonly", "READONLY")),
    }
    const owed = (await db.repaymentSchedule.findMany({ where: { loanId: loans.settle } })).reduce((n, r) => n + Math.max(0, r.totalDue - r.totalPaid), 0)
    const shape = {
      positions: await db.telematicsPosition.count({ where: { tenantId: fx.tenantId, deviceId: devices.theft } }),
      spikeReading: (await db.assetMeterReading.findFirstOrThrow({ where: { loanId: loans.spike, source: "TELEMATICS" }, orderBy: { value: "desc" }, select: { value: true } })).value,
      closures: await db.trackerClosure.count({ where: { tenantId: fx.tenantId } }),
      theftReports: await db.assetTheftReport.count({ where: { tenantId: fx.tenantId } }),
    }
    expect(shape.positions).toBeGreaterThan(20)
    expect(shape).toMatchObject({ spikeReading: held.value, closures: 0, theftReports: 0 })

    writeFileSync(OUT, JSON.stringify({
      tenantId: fx.tenantId, slug: `af-deal-${token}`, host: fx.host, password: PASSWORD, totpSecret: TOTP_SECRET, installedOn,
      staff, portal: { email: director.email, password: PASSWORD, clientId: director.id }, loans, devices, owedOnSettle: owed, smtpPort: SMTP_PORT, shape,
    }, null, 2), { mode: 0o600 })
  } finally {
    await db.$disconnect()
  }
}, 600_000)
