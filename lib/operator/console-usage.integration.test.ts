/**
 * Real-Postgres proof of the operator console's usage counts (per lender, per
 * SAST month, aggregates only) and of operator sign-in against real rows.
 *
 * Usage fixtures are inserted with triggers off (session_replication_role =
 * replica; CHECK constraints still apply): the counts read the rows, not the
 * lifecycle that would normally produce them.
 *
 *   RUN_OPERATOR_CONSOLE_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/operator/console-usage.integration.test.ts
 */
import bcrypt from "bcryptjs"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  config: null as null | { providers: Array<{ authorize: (c: Record<string, string>, r: Request) => Promise<unknown> }> },
}))
vi.mock("next-auth", () => ({
  default: (config: typeof m.config) => {
    m.config = config
    return { handlers: {}, auth: async () => null, signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class extends Error { code = "credentials" },
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))

import "@/lib/auth"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"
import { operatorUsageForMonth, usageMonth } from "./console/usage"
import { listOperatorLenders } from "./console/lenders"
import { createIsolationFixture, dropIsolationFixture, type IsolationFixture } from "../tenant-isolation.integration-fixture"

const suite = process.env.RUN_OPERATOR_CONSOLE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const CONSOLE = "console.op-it.invalid"
const PASSWORD = "synthetic-Passw0rd!"
const SECRET = generateTotpSecret()
let f: IsolationFixture
let operatorAdminId = ""
const at = (iso: string) => new Date(iso)

async function seedUsage(): Promise<void> {
  const t = f.a.tenantId
  const c = f.a.clientId
  const k = f.token
  // One product per application: a client holds one application per product.
  const APPS = ["in1", "in2", "before", "after", "x", "y"]
  const product = (appId: string) => `usage-prod-${appId}-${k}`
  const app = (id: string, createdAt: string, disbursedAt: string | null) => db.loanApplication.create({
    data: { id: `${id}-${k}`, tenantId: t, reference: `USG-${id}-${k}`, clientId: c, productId: product(id), appliedAmount: 100_000, appliedTermDays: 90, createdAt: at(createdAt), disbursedAt: disbursedAt ? at(disbursedAt) : null },
  })
  const loan = (id: string, appId: string, status: "ACTIVE" | "COMPLETED" | "WRITTEN_OFF" | "CANCELLED", start: string, extra: { closedAt?: string; writeOffAt?: string; principal?: number } = {}) => db.loan.create({
    data: {
      tenantId: t, reference: `USG-LN-${id}-${k}`, applicationId: `${appId}-${k}`, clientId: c, productId: product(appId),
      principal: extra.principal ?? 100_000, totalInterest: 0, initiationFee: 0, totalRepayable: 100_000, outstandingPrincipal: 0,
      startDate: at(start), maturityDate: at("2027-01-01T00:00:00Z"), interestRatePm: 0, interestModel: "FLAT", status,
      closedAt: extra.closedAt ? at(extra.closedAt) : null, writeOffAt: extra.writeOffAt ? at(extra.writeOffAt) : null,
    },
  })
  const msg = (n: number, direction: "OUTBOUND" | "INBOUND", sentAt: string) => db.message.create({
    data: { tenantId: t, conversationId: `usage-conv-${k}`, channel: "EMAIL", direction, provider: "SMTP", status: "SENT", sentAt: at(sentAt), bodyText: `Synthetic ${n}` },
  })
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    ...APPS.map((id) => db.loanProduct.create({
      data: { id: product(id), tenantId: t, code: `USG-${id}-${k}`, name: "Usage", productType: "PERSONAL", minAmount: 1, maxAmount: 10_000_000, minTermDays: 30, maxTermDays: 365, interestRatePm: 0, interestModel: "FLAT" },
    })),
    // 1 Mar 00:30 SAST and 31 Mar 23:59 SAST are in March; 28 Feb 23:30 SAST and 1 Apr 00:00 SAST are not.
    app("in1", "2026-02-28T22:30:00Z", "2026-03-05T10:00:00Z"),
    app("in2", "2026-03-31T21:59:00Z", null),
    app("before", "2026-02-28T21:30:00Z", "2026-02-28T21:00:00Z"),
    app("after", "2026-03-31T22:00:00Z", null),
    app("x", "2025-12-01T10:00:00Z", null),
    app("y", "2025-12-02T10:00:00Z", null),
    loan("closed-in-march", "in1", "COMPLETED", "2026-03-05T10:00:00Z", { closedAt: "2026-03-20T10:00:00Z", principal: 300_000 }),
    loan("closed-in-feb", "before", "COMPLETED", "2026-01-10T10:00:00Z", { closedAt: "2026-02-20T10:00:00Z" }),
    loan("starts-april", "after", "ACTIVE", "2026-04-02T10:00:00Z"),
    loan("written-off-march", "in2", "WRITTEN_OFF", "2026-01-01T10:00:00Z", { writeOffAt: "2026-03-10T10:00:00Z" }),
    loan("on-book", "x", "ACTIVE", "2026-01-15T10:00:00Z"),
    // Cancelled in March: closed in the month, but never on the book.
    loan("cancelled", "y", "CANCELLED", "2026-01-15T10:00:00Z", { closedAt: "2026-03-15T10:00:00Z" }),
    ...["2026-03-02T08:00:00Z", "2026-03-30T08:00:00Z", "2026-02-27T08:00:00Z"].map((createdAt, i) =>
      db.integrationLog.create({ data: { tenantId: t, provider: "EXPERIAN", action: `usage-${i}`, status: "OK", createdAt: at(createdAt) } })),
    db.contact.create({ data: { id: `usage-contact-${k}`, tenantId: t, firstSeenChannel: "EMAIL" } }),
    db.conversation.create({ data: { id: `usage-conv-${k}`, tenantId: t, contactId: `usage-contact-${k}`, channel: "EMAIL" } }),
    msg(1, "OUTBOUND", "2026-03-03T08:00:00Z"),
    msg(2, "OUTBOUND", "2026-03-31T21:00:00Z"),
    msg(3, "INBOUND", "2026-03-04T08:00:00Z"),
    msg(4, "OUTBOUND", "2026-03-31T22:30:00Z"),
  ])
}

suite("operator console usage counts and operator sign-in — real database", () => {
  beforeAll(async () => {
    f = await createIsolationFixture(db)
    await seedUsage()
    const admin = await db.user.create({
      data: {
        operatorId: f.operatorId, email: `opadmin-${f.token}@op-it.invalid`, name: "Op Admin", role: "OPERATOR_ADMIN",
        password: bcrypt.hashSync(PASSWORD, 4), totpSecret: SECRET, totpEnabled: true,
      },
    })
    operatorAdminId = admin.id
    await db.user.update({ where: { id: f.a.adminId }, data: { password: bcrypt.hashSync(PASSWORD, 4) } })
    vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  }, 60_000)

  afterAll(async () => {
    const t = [f.a.tenantId]
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      ...["Message", "Conversation", "Contact", "IntegrationLog", "Loan", "LoanApplication", "LoanProduct"]
        .map((table) => db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1)`, t)),
      db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, operatorAdminId),
      db.$executeRawUnsafe(`DELETE FROM "FailedLoginAttempt" WHERE "email" LIKE $1`, `%${f.token}%`),
    ])
    await dropIsolationFixture(db, f)
    await db.$disconnect()
  })

  it("counts March 2026 (SAST) per lender: applications, loans on the book, disbursements, provider calls, messages", async () => {
    const rows = await operatorUsageForMonth(f.operatorId, usageMonth("2026-03"))
    expect(rows.find((r) => r.tenantId === f.a.tenantId)).toMatchObject({
      applications: 2, activeLoans: 3, disbursements: 1, disbursedCents: 300_000, providerApiCalls: 2, messagesSent: 2,
    })
    expect(rows.find((r) => r.tenantId === f.b.tenantId)).toMatchObject({
      applications: 0, activeLoans: 0, disbursements: 0, disbursedCents: 0, providerApiCalls: 0, messagesSent: 0,
    })
    expect(await operatorUsageForMonth(f.otherOperatorId, usageMonth("2026-03"))).toEqual([])
  })

  it("counts the book on the lender list (collectible loans and clients), never another operator's lenders", async () => {
    const lenders = await listOperatorLenders(f.operatorId)
    expect(lenders.find((l) => l.id === f.a.tenantId)).toMatchObject({ activeLoans: 3, clients: 1 })
    expect(await listOperatorLenders(f.otherOperatorId)).toEqual([])
  })

  const signIn = (host: string, loginType: string, email: string, code?: string) =>
    m.config!.providers[0].authorize(
      { email, password: PASSWORD, loginType, ...(code ? { code } : {}) },
      new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host } }),
    )

  it("signs an operator user in on the console host with a TOTP code; refuses them once deactivated", async () => {
    const email = `opadmin-${f.token}@op-it.invalid`
    await expect(signIn(CONSOLE, "operator", email, generateTotpCode(SECRET))).resolves.toMatchObject({
      id: operatorAdminId, operatorId: f.operatorId, tenantId: null, totpVerified: true,
    })
    await db.user.update({ where: { id: operatorAdminId }, data: { active: false } })
    await expect(signIn(CONSOLE, "operator", email, generateTotpCode(SECRET, Date.now() + 30_000))).resolves.toBeNull()
  })

  it("keeps lender staff off the console host and operator staff off the lender's", async () => {
    await expect(signIn(CONSOLE, "staff", `admin-a-${f.token}@iso-it.invalid`)).rejects.toMatchObject({ code: "wrong_audience" })
    await expect(signIn(CONSOLE, "operator", `admin-a-${f.token}@iso-it.invalid`)).resolves.toBeNull()
    await expect(signIn("localhost", "operator", `opadmin-${f.token}@op-it.invalid`)).rejects.toMatchObject({ code: "wrong_audience" })
  })
})
