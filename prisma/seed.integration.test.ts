/**
 * Fresh-database proof for the base demo seed.
 *
 * Self-contained: each suite creates its own throwaway database (seed_it_<hex>)
 * on the server DATABASE_URL points at, migrates it, seeds it and drops it, so
 * it passes even when DATABASE_URL is the shared, already-populated database
 * that scripts/run-integration-tests.sh runs every suite against. The role in
 * DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_SEED_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run prisma/seed.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { LENDER_IDENTITY_SELECT, parseLenderIdentity } from "@/lib/config/identity-schema"
import { DEFAULT_MESSAGE_TEMPLATES } from "@/lib/messaging/default-templates"

const RUN = process.env.RUN_SEED_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const LOAN_REF = "LN-SEED-0001"
const ADMIN_EMAIL = "admin@acme-lending.example"
// CLIENTS[0].idNumber in prisma/seed.ts.
const SEED_ID_NUMBER = "8503015000081"

type ThrowawayDb = { name: string; url: string; prisma: PrismaClient }

/** Creates seed_it_<hex> next to DATABASE_URL's database and migrates it. */
async function createThrowawayDb(admin: PrismaClient, created: string[]): Promise<ThrowawayDb> {
  const name = `seed_it_${randomBytes(6).toString("hex")}`
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  created.push(name)
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.pathname = `/${name}`
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: ["ignore", "pipe", "pipe"],
  })
  return { name, url: url.toString(), prisma: new PrismaClient({ datasources: { db: { url: url.toString() } } }) }
}

async function dropThrowawayDbs(admin: PrismaClient | null, created: string[], dbs: (ThrowawayDb | undefined)[]) {
  for (const db of dbs) await db?.prisma.$disconnect()
  for (const name of created) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  await admin?.$disconnect()
}

function run(url: string, args: string[], extraEnv: Record<string, string> = {}) {
  return execFileSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url, ...extraEnv },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}
const runSeed = (url: string, extraEnv: Record<string, string> = {}) => run(url, ["npm", "run", "seed:base", "--silent"], extraEnv)
const runStagingSeed = (url: string) => run(url, ["npx", "tsx", "prisma/seed-staging.ts"])

/** The stderr of a seed run that must fail; throws if it succeeded. */
function failedRunStderr(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? error)
  }
  throw new Error("expected the seed run to fail, but it succeeded")
}

suite("base demo seed on a fresh migrated database", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  let fresh: ThrowawayDb | undefined
  const freshDb = () => {
    if (!fresh) throw new Error("RUN_SEED_DB_IT=1 is required")
    return fresh.prisma
  }

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    fresh = await createThrowawayDb(admin, created)
    const prisma = fresh.prisma

    const existingRows = await Promise.all([
      prisma.tenant.count(),
      prisma.client.count(),
      prisma.loanApplication.count(),
      prisma.loan.count(),
    ])
    expect(existingRows).toEqual([0, 0, 0, 0])

    // A failure after the schedule rows are written rolls the whole loan back.
    expect(() => runSeed(fresh!.url, { NODE_ENV: "test", SEED_FAIL_AFTER_SCHEDULES_FOR_REFERENCE: LOAN_REF })).toThrow()
    expect(await prisma.loan.count({ where: { reference: LOAN_REF } })).toBe(0)
    expect(await prisma.loanApplication.count({ where: { reference: "APP-SEED-0004" } })).toBe(0)
    expect(await prisma.repaymentSchedule.count()).toBe(0)

    runSeed(fresh.url)
  }, 120_000)

  afterAll(async () => {
    await dropThrowawayDbs(admin, created, [fresh])
  })

  it("creates the Acme tenant with a complete, valid lender identity and its default templates", async () => {
    const prisma = freshDb()

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { slug: "acme" },
      select: { id: true, config: { select: LENDER_IDENTITY_SELECT } },
    })
    expect(parseLenderIdentity(tenant.config)).toEqual(ACME_LENDER)
    expect(await prisma.messageTemplate.count({ where: { tenantId: tenant.id } })).toBe(DEFAULT_MESSAGE_TEMPLATES.length)
    expect(await prisma.documentTemplate.count({ where: { tenantId: tenant.id } })).toBeGreaterThan(0)
  })

  it("enrols every seeded staff user in TOTP", async () => {
    const prisma = freshDb()

    const staff = await prisma.user.findMany({ select: { email: true, role: true, totpEnabled: true, totpSecret: true } })
    expect(staff.map((u) => [u.email, u.role]).sort()).toEqual([
      [ADMIN_EMAIL, "ADMIN"],
      ["credit.officer@acme-lending.example", "CREDIT_OFFICER"],
      ["loan.admin.one@acme-lending.example", "LOAN_ADMIN"],
      ["loan.admin.two@acme-lending.example", "LOAN_ADMIN"],
    ])
    for (const user of staff) {
      expect(user.totpEnabled).toBe(true)
      expect(user.totpSecret).toMatch(/^[A-Z2-7]{32}$/)
    }
  })

  it("keeps KYC pending while recording the synthetic NCA lifecycle evidence", async () => {
    const prisma = freshDb()

    const [
      clientCount,
      applicationCount,
      loanCount,
      verifiedCount,
      pendingCount,
      clientDocumentCount,
      complianceRecordCount,
      protectedLifecycleCount,
      insurancePolicyCount,
      nonInvalidEmailCount,
    ] = await Promise.all([
      prisma.client.count(),
      prisma.loanApplication.count(),
      prisma.loan.count(),
      prisma.client.count({ where: { kycStatus: "VERIFIED" } }),
      prisma.client.count({ where: { kycStatus: "PENDING" } }),
      prisma.clientDocument.count(),
      prisma.complianceRecord.count(),
      // Consumer borrowers only: the natural-person asset-finance deal is
      // deliberately taken through its NCA lifecycle by the seed.
      prisma.loanApplication.count({ where: { status: { in: ["APPROVED", "DISBURSED"] }, clientId: { not: null } } }),
      prisma.insurancePolicy.count(),
      prisma.client.count({ where: { NOT: { email: { endsWith: ".invalid" } } } }),
    ])

    expect({
      clientCount,
      applicationCount,
      loanCount,
      verifiedCount,
      pendingCount,
      clientDocumentCount,
      complianceRecordCount,
      protectedLifecycleCount,
      insurancePolicyCount,
      nonInvalidEmailCount,
    }).toEqual({
      // 5 consumer clients + 4 asset-finance people; four consumer applications
      // plus three asset-finance applications, and one plus three loans.
      clientCount: 9,
      applicationCount: 7,
      loanCount: 4,
      verifiedCount: 0,
      pendingCount: 9,
      clientDocumentCount: 2,
      complianceRecordCount: 4,
      protectedLifecycleCount: 1,
      insurancePolicyCount: 1,
      nonInvalidEmailCount: 0,
    })
  })

  it("books the demo loan with a schedule that equals its own totals and no receipts", async () => {
    const prisma = freshDb()

    const loan = await prisma.loan.findUniqueOrThrow({
      where: { reference: LOAN_REF },
      include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } }, payments: true },
    })
    const rows = loan.repaymentSchedule
    expect(loan.status).toBe("ACTIVE")
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.reduce((s, r) => s + r.totalDue, 0)).toBe(loan.totalRepayable)
    expect(rows.reduce((s, r) => s + r.principalDue, 0)).toBe(loan.principal)
    expect(loan.outstandingPrincipal).toBe(loan.principal)
    expect(loan.totalPaid).toBe(0)
    expect(loan.payments).toEqual([])
    expect(rows.every((r) => r.status === "PENDING" && r.totalPaid === 0 && r.paidAt === null)).toBe(true)
    expect(loan.nextPaymentDate?.getTime()).toBe(rows[0].dueDate.getTime())
    expect(loan.maturityDate.getTime()).toBe(rows.at(-1)!.dueDate.getTime())
  })

  it("reruns idempotently and keeps each staff user's TOTP secret and every password", async () => {
    const prisma = freshDb()

    const snapshot = async () => ({
      counts: await Promise.all([
        prisma.tenant.count(),
        prisma.user.count(),
        prisma.loanProduct.count(),
        prisma.client.count(),
        prisma.loanApplication.count(),
        prisma.loan.count(),
        prisma.repaymentSchedule.count(),
        prisma.payment.count(),
        prisma.messageTemplate.count(),
        prisma.documentTemplate.count(),
        prisma.auditLog.count(),
      ]),
      secrets: (await prisma.user.findMany({ orderBy: { email: "asc" }, select: { totpSecret: true } })).map((u) => u.totpSecret),
      passwords: (await prisma.user.findMany({ orderBy: { email: "asc" }, select: { password: true } })).map((u) => u.password),
      portal: (await prisma.client.findMany({ orderBy: { idNumber: "asc" }, select: { portalPassword: true } })).map((c) => c.portalPassword),
    })

    const before = await snapshot()
    expect(runSeed(fresh!.url, { SEED_PRINT_CREDENTIALS: "1" })).not.toMatch(/password[^:]*: Demo-/)
    expect(await snapshot()).toEqual(before)
  }, 120_000)
})

// No demo password is in source: each is generated when its row is first
// created (or taken from SEED_*_PASSWORD) and printed only on request.
suite("demo seed passwords", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  let db: ThrowawayDb | undefined
  let firstRunOutput = ""
  const STAFF = [ADMIN_EMAIL, "credit.officer@acme-lending.example", "loan.admin.one@acme-lending.example", "loan.admin.two@acme-lending.example"]
  // The asset-finance portal logins have known passwords (prisma/seed/asset-finance-data.ts), not these.
  const CONSUMER_CLIENTS = { NOT: { reference: { startsWith: "CLI-SEED-AF-" } } }

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    db = await createThrowawayDb(admin, created)
    firstRunOutput = runSeed(db.url, { SEED_PRINT_CREDENTIALS: "1" })
  }, 120_000)

  afterAll(async () => {
    await dropThrowawayDbs(admin, created, [db])
  })

  const passwords = async () => ({
    staff: (await db!.prisma.user.findMany({ orderBy: { email: "asc" }, select: { password: true } })).map((u) => u.password),
    portal: (await db!.prisma.client.findMany({ where: CONSUMER_CLIENTS, orderBy: { idNumber: "asc" }, select: { portalPassword: true } })).map((c) => c.portalPassword ?? ""),
  })

  it("generates them on the first run and prints the ones it stored", async () => {
    const printed = (label: RegExp) => label.exec(firstRunOutput)?.[1] ?? "(not printed)"
    for (const email of STAFF) {
      const password = printed(new RegExp(`${email.replace(/\./g, "\\.")}\\n\\s+password: (Demo-\\S+)`))
      const { password: hash } = await db!.prisma.user.findUniqueOrThrow({ where: { email }, select: { password: true } })
      expect(await bcrypt.compare(password, hash)).toBe(true)
    }
    const portal = printed(/Client portal password[^:]*: (Demo-\S+)/)
    const { portal: hashes } = await passwords()
    expect(hashes).toHaveLength(5)
    for (const hash of hashes) expect(await bcrypt.compare(portal, hash)).toBe(true)
  })

  it("keeps every password on a rerun and prints none", async () => {
    const before = await passwords()
    expect(runSeed(db!.url, { SEED_PRINT_CREDENTIALS: "1" })).not.toMatch(/: Demo-/)
    expect(await passwords()).toEqual(before)
  }, 120_000)

  it("sets the passwords SEED_*_PASSWORD names", async () => {
    runSeed(db!.url, {
      SEED_ADMIN_PASSWORD: "synthetic-admin-pass-1",
      SEED_OFFICER_PASSWORD: "synthetic-officer-pass-1",
      SEED_PORTAL_PASSWORD: "synthetic-portal-pass-1",
    })
    for (const [email, expected] of [[STAFF[0], "synthetic-admin-pass-1"], [STAFF[1], "synthetic-officer-pass-1"]]) {
      const { password } = await db!.prisma.user.findUniqueOrThrow({ where: { email }, select: { password: true } })
      expect(await bcrypt.compare(expected, password)).toBe(true)
    }
    for (const hash of (await passwords()).portal) expect(await bcrypt.compare("synthetic-portal-pass-1", hash)).toBe(true)
  }, 120_000)
})

// A shared non-production database can hold several tenants. User.email and
// Client.idNumber are globally unique, so an upsert keyed on them alone would
// silently rewrite another tenant's row (its password, its tenantId).
suite("demo seeds never touch another tenant's rows", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  let db: ThrowawayDb | undefined
  let otherTenantId = ""
  const conflictDb = () => {
    if (!db) throw new Error("RUN_SEED_DB_IT=1 is required")
    return db
  }

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    db = await createThrowawayDb(admin, created)
    otherTenantId = (await db.prisma.tenant.create({ data: { slug: "other", name: "Other Lender", status: "ACTIVE" } })).id
  }, 120_000)

  afterAll(async () => {
    await dropThrowawayDbs(admin, created, [db])
  })

  it("refuses when a seeded staff email belongs to another tenant, and leaves that user untouched", async () => {
    const { prisma, url } = conflictDb()
    const foreign = await prisma.user.create({
      data: { tenantId: otherTenantId, email: ADMIN_EMAIL, name: "Other Admin", role: "ADMIN", password: "other-hash" },
    })

    expect(failedRunStderr(() => runSeed(url))).toContain(`user ${ADMIN_EMAIL} belongs to another tenant`)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreign)

    // Out of the way for the next case (same row, new email: nothing to delete).
    await prisma.user.update({ where: { id: foreign.id }, data: { email: "other.admin@other-lender.example" } })
  }, 120_000)

  it("refuses when a seeded client ID number belongs to another tenant, and leaves that client untouched", async () => {
    const { prisma, url } = conflictDb()
    const foreign = await prisma.client.create({
      data: {
        tenantId: otherTenantId, reference: "CLI-OTHER-0001", idNumber: SEED_ID_NUMBER,
        firstName: "Other", lastName: "Client", email: "client@other-lender.invalid", phone: "+27700000001",
      },
    })

    expect(failedRunStderr(() => runSeed(url))).toContain(`client with ID number ${SEED_ID_NUMBER} belongs to another tenant`)
    expect(await prisma.client.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreign)
  }, 120_000)

  it("staging seed only uses the Acme tenant's own staff", async () => {
    const { prisma, url } = conflictDb()
    // Free the ID number (the foreign client keeps its row), complete the base
    // seed, then hand the Acme staff to the other tenant.
    await prisma.client.update({ where: { idNumber: SEED_ID_NUMBER }, data: { idNumber: "9001015800087" } })
    runSeed(url)
    // The asset-finance rows the staff acted on reference them by composite
    // (tenantId, userId) foreign keys, which refuse the move; this database is
    // dropped afterwards, so they are bypassed for the hand-over only.
    await prisma.$transaction([
      prisma.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      prisma.user.updateMany({ where: { email: { endsWith: "@acme-lending.example" } }, data: { tenantId: otherTenantId } }),
    ])

    expect(failedRunStderr(() => runStagingSeed(url))).toContain("Base demo users are missing")
    const staff = await prisma.user.findMany({ where: { tenantId: otherTenantId }, select: { branchId: true } })
    expect(staff.map((u) => u.branchId)).toEqual([null, null, null, null, null])
    expect(await prisma.branch.count()).toBe(0)
  }, 180_000)
})

suite("base demo seed as another demo lender (DEMO_LENDER=fairscore)", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  let db: ThrowawayDb | undefined
  const prisma = () => {
    if (!db) throw new Error("RUN_SEED_DB_IT=1 is required")
    return db.prisma
  }

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_SEED_DB_IT=1 is required")
    db = await createThrowawayDb(admin, created)
    runSeed(db.url, { DEMO_LENDER: "fairscore" })
  }, 120_000)

  afterAll(async () => {
    await dropThrowawayDbs(admin, created, [db])
  })

  it("brands the tenant, its identity, colours and templates as Fairscore", async () => {
    const tenant = await prisma().tenant.findUniqueOrThrow({
      where: { slug: "fairscore" },
      select: { id: true, name: true, config: { select: { ...LENDER_IDENTITY_SELECT, primaryColor: true, secondaryColor: true, darkColor: true } } },
    })
    expect(await prisma().tenant.count()).toBe(1)
    expect(tenant.name).toBe("Fairscore")
    expect(parseLenderIdentity(tenant.config)).toMatchObject({
      legalName: "Fairscore (Pty) Ltd",
      tradingName: "Fairscore",
      publicEmail: "hello@fairscore.example",
      collectionsEmail: "collections@fairscore.example",
    })
    expect(tenant.config).toMatchObject({ primaryColor: "#033483", secondaryColor: "#0A63B8", darkColor: "#0F1A2E" })
    expect(await prisma().messageTemplate.count({ where: { tenantId: tenant.id } })).toBe(DEFAULT_MESSAGE_TEMPLATES.length)
  })

  it("puts staff on fairscore.example and borrowers on fairscore.invalid", async () => {
    const staff = await prisma().user.findMany({ select: { email: true } })
    expect(staff.map((u) => u.email).sort()).toEqual([
      "admin@fairscore.example", "credit.officer@fairscore.example", "loan.admin.one@fairscore.example", "loan.admin.two@fairscore.example",
    ])
    const clients = await prisma().client.findMany({ select: { email: true } })
    // 5 consumer clients + 4 asset-finance people (prisma/seed/asset-finance-data.ts).
    expect(clients).toHaveLength(9)
    for (const c of clients) expect(c.email).toMatch(/^[a-z.]+@fairscore\.invalid$/)
  })

  it("leaves no Acme text in any row it wrote", async () => {
    const tables = await prisma().$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('text', 'character varying')`
    const hits: string[] = []
    for (const { table_name, column_name } of tables) {
      // A word that starts with "acme" ("Acme Lending", "@acme-lending.example"),
      // not any substring: a random cuid, TOTP secret or bcrypt hash can contain
      // "acme" mid-string (this flaked on a MessageTemplate cuid, 2026-10-15).
      const [{ n }] = await prisma().$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE "${column_name}" ~* '\\macme'`,
      )
      if (n > BigInt(0)) hits.push(`${table_name}.${column_name}`)
    }
    expect(hits).toEqual([])
  })
})
