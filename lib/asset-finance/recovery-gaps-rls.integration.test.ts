/**
 * Row-level security on the slice 4a recovery tables, under a role it binds
 * (neither superuser nor BYPASSRLS; a superuser would ignore every policy and
 * prove nothing): lender A's session reads none of lender B's recoveries,
 * matters or steps, its raw UPDATE of B's recovery touches nothing, and it
 * cannot insert a row as B. The application client is the production one
 * (lib/prisma.ts: tenant-scope extension, RLS hook), as in
 * lib/tenant-isolation.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-rls.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { addStep, cleanupRecoveryFixture, createRecoveryFixture, newLoan, newMatter, newRecovery, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"

// The deal fixture imports the real route handlers, which import the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const tA = randomUUID().replaceAll("-", "").slice(0, 16)
const tB = randomUUID().replaceAll("-", "").slice(0, 16)
const ROLE = `cf_gaps_rls_${tA.slice(0, 10)}`

interface Lender { fx: RecoveryFixture; recoveryId: string; matterId: string; stepId: string; loanId: string }
let A: Lender
let B: Lender
let app: ReturnType<typeof createAppPrismaClient>

async function lender(t: string): Promise<Lender> {
  const fx = await createRecoveryFixture(database(), t)
  const loan = await newLoan(database(), fx, "NON_NCA")
  const matterLoan = await newLoan(database(), fx, "NCA")
  const matterId = await newMatter(database(), fx, matterLoan.loanId)
  return {
    fx, loanId: loan.loanId, recoveryId: await newRecovery(database(), fx, loan, "NON_NCA_VOLUNTARY"), matterId, stepId: await addStep(database(), fx, matterId, "LETTER_OF_DEMAND"),
  }
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

suite("slice 4a recovery tables: lender A against lender B under row-level security", () => {
  beforeAll(async () => {
    vi.stubEnv("TENANT_RLS", "on")
    const password = randomBytes(12).toString("hex")
    await database().$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
    await database().$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
    await database().$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
    await database().$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
    A = await lender(tA)
    B = await lender(tB)
    app = createAppPrismaClient(roleUrl(password))
  }, 300_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    for (const t of [tA, tB]) await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await database().$executeRawUnsafe(`DROP OWNED BY ${ROLE}`).catch(() => undefined)
    await database().$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined)
    await database().$disconnect()
  }, 120_000)

  const asA = <T>(fn: () => PromiseLike<T>) => runWithTenant(A.fx.tenantId, async () => await fn())

  it("connects as a role row-level security binds (otherwise every assertion below is vacuous)", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("lender A reads its own recovery, matter and step, and none of lender B's, by raw SQL", async () => {
    const seen = await asA(() => app.$queryRaw<{ t: string; own: number; other: number }[]>`
      SELECT 'recovery' AS t, count(*) FILTER (WHERE "id" = ${A.recoveryId})::int AS own, count(*) FILTER (WHERE "id" = ${B.recoveryId})::int AS other FROM "Recovery"
      UNION ALL SELECT 'matter', count(*) FILTER (WHERE "id" = ${A.matterId})::int, count(*) FILTER (WHERE "id" = ${B.matterId})::int FROM "LegalMatter"
      UNION ALL SELECT 'step', count(*) FILTER (WHERE "id" = ${A.stepId})::int, count(*) FILTER (WHERE "id" = ${B.stepId})::int FROM "LegalMatterStep"`)
    expect(seen.map((r) => [r.t, r.own, r.other])).toEqual([["recovery", 1, 0], ["matter", 1, 0], ["step", 1, 0]])
  })

  it("lender A's Prisma read of lender B's recovery by id finds nothing", async () => {
    expect(await asA(() => app.recovery.findMany({ where: { id: B.recoveryId } }))).toEqual([])
    expect(await asA(() => app.recovery.findMany({ where: { id: A.recoveryId }, select: { id: true } }))).toEqual([{ id: A.recoveryId }])
  })

  it("lender A's raw UPDATE of lender B's recovery touches no row, and B's recovery is unchanged", async () => {
    expect(await asA(() => app.$executeRaw`UPDATE "Recovery" SET "location" = 'Mutated' WHERE "id" = ${B.recoveryId}`)).toBe(0)
    expect((await database().recovery.findUniqueOrThrow({ where: { id: B.recoveryId } })).location).toBe("TEST Yard")
  })

  it("lender A cannot insert a legal matter as lender B", async () => {
    const attack = asA(() => app.$executeRaw`
      INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt")
      VALUES (${`gaps-rls-${tA}`}, ${B.fx.tenantId}, ${B.loanId}, ${B.fx.officer}, CURRENT_TIMESTAMP)`)
    await expect(attack).rejects.toThrow(/new row violates row-level security policy for table "LegalMatter"/)
    expect(await database().legalMatter.count({ where: { id: `gaps-rls-${tA}` } })).toBe(0)
  })
})
