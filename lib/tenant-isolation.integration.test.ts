/**
 * Real-Postgres proof that row-level security isolates lenders underneath the
 * tenant-scope extension (lib/tenant-rls.ts, migration 20261014130000_tenant_rls),
 * and that borrowers are per lender (the same ID number and email in two).
 *
 * The application client runs exactly as in production (lib/prisma.ts: the
 * tenant-scope extension, the RLS hook, the $transaction wrapper) but connects
 * as a role RLS binds: neither superuser nor BYPASSRLS. DATABASE_URL is a
 * superuser in CI and locally, and a superuser ignores every policy, so a
 * suite on that connection would be green while proving nothing. The pool is
 * one connection, so a setting that leaked past its transaction would be seen
 * by the next query.
 *
 *   RUN_TENANT_ISOLATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/tenant-isolation.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant, withoutTenantScope, TENANT_SCOPED_MODELS } from "@/lib/tenant-scope"
import { RlsTransactionTenantError } from "@/lib/tenant-rls"
import { createIsolationFixture, dropIsolationFixture, type IsolationFixture } from "./tenant-isolation.integration-fixture"

const suite = process.env.RUN_TENANT_ISOLATION_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const ROLE = "cf_tenant_isolation_it"

let f: IsolationFixture | undefined
let app: ReturnType<typeof createAppPrismaClient>
const fx = () => {
  if (!f) throw new Error("fixture missing")
  return f
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} RESET app.rls_strict`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}

const asA = <T>(fn: () => PromiseLike<T>) => runWithTenant(fx().a.tenantId, async () => await fn())
const clientCount = (rows: { n: number }[]) => rows[0].n
const countSameIdRaw = (c: typeof app) =>
  c.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Client" WHERE "idNumber" = ${fx().idNumber}`

/** Tables the RLS migration must cover: the scoped models plus the borrower-core extras. */
const COVERED = [
  ...TENANT_SCOPED_MODELS,
  "PasqAcknowledgementToken", "SelfieCaptureToken", "SurrenderRequest", "InsuranceQuote", "Lead",
  "AttorneyReferral", "PaymentPlan", "StitchPaymentRequest", "ClientExpenseBreakdown",
  "ExistingDebtObligation", "ClientConsent", "InsuredLife",
]

suite("tenant isolation — RLS under the application client", () => {
  let password = ""

  beforeAll(async () => {
    // The hook is off by default (lib/tenant-rls.ts); this suite is what it is for.
    vi.stubEnv("TENANT_RLS", "on")
    password = await createAppRole()
    f = await createIsolationFixture(db)
    app = createAppPrismaClient(roleUrl(password))
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    await dropIsolationFixture(db, f)
    await db.$disconnect()
  })

  it("connects as a role RLS binds (otherwise every assertion below is vacuous)", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("enables and FORCEs row-level security with a policy on every covered table", async () => {
    const rows = await db.$queryRaw<{ t: string; on: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS t, c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${COVERED})`
    expect(rows.map((r) => r.t).sort()).toEqual([...COVERED].sort())
    expect(rows.filter((r) => !r.on || !r.forced || r.policies !== 1)).toEqual([])
  })

  it("keeps the same ID number and email as two clients, one per lender, and refuses a second in one lender", async () => {
    const rows = await db.client.findMany({ where: { idNumber: fx().idNumber }, select: { tenantId: true, email: true } })
    expect(rows.map((r) => r.tenantId).sort()).toEqual([fx().a.tenantId, fx().b.tenantId].sort())
    expect(new Set(rows.map((r) => r.email))).toEqual(new Set([fx().email]))
    await expect(db.client.create({
      data: { tenantId: fx().a.tenantId, idNumber: fx().idNumber, email: `other-${fx().token}@iso-it.invalid`, firstName: "S", lastName: "D", phone: "0" },
    })).rejects.toMatchObject({ code: "P2002", meta: { target: ["tenantId", "idNumber"] } })
  })

  it("lender A's raw SQL sees only lender A's rows, across the borrower core and a child scoped via its parent", async () => {
    const seen = await asA(() => app.$queryRaw<{ t: string; n: number }[]>`
      SELECT 'client' AS t, count(*)::int AS n FROM "Client" WHERE "tenantId" = ${fx().b.tenantId}
      UNION ALL SELECT 'document', count(*)::int FROM "ClientDocument" WHERE "id" = ${fx().b.documentId}
      UNION ALL SELECT 'application', count(*)::int FROM "LoanApplication" WHERE "id" = ${fx().b.applicationId}
      UNION ALL SELECT 'loan', count(*)::int FROM "Loan" WHERE "id" = ${fx().b.loanId}
      UNION ALL SELECT 'expenses', count(*)::int FROM "ClientExpenseBreakdown" WHERE "clientId" = ${fx().b.clientId}`)
    expect(seen.map((r) => [r.t, r.n])).toEqual([["client", 0], ["document", 0], ["application", 0], ["loan", 0], ["expenses", 0]])
    expect(clientCount(await asA(() => countSameIdRaw(app)))).toBe(1)
  })

  it("lender A's Prisma reads see no lender-B row, even through a relation the extension does not rewrite", async () => {
    const viaTenant = await asA(() => app.tenant.findUnique({ where: { id: fx().b.tenantId }, include: { clients: true, loans: true } }))
    expect(viaTenant?.clients).toEqual([])
    expect(viaTenant?.loans).toEqual([])
    const own = await asA(() => app.client.findMany({ where: { idNumber: fx().idNumber }, select: { id: true } }))
    expect(own).toEqual([{ id: fx().a.clientId }])
  })

  it("lender A cannot write lender-B rows: raw UPDATE touches nothing, a nested write changes nothing, an INSERT as B is refused", async () => {
    expect(await asA(() => app.$executeRaw`UPDATE "Client" SET "firstName" = 'Mutated' WHERE "id" = ${fx().b.clientId}`)).toBe(0)
    await asA(() => app.tenant.update({
      where: { id: fx().b.tenantId },
      data: { loans: { updateMany: { where: {}, data: { collectionsNotes: "Mutated" } } } },
    }))
    await expect(asA(() => app.$executeRaw`
      INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileName", "fileUrl")
      VALUES (${`iso-doc-${fx().token}`}, ${fx().b.tenantId}, ${fx().b.clientId}, 'ID_COPY', 'x.pdf', '/x.pdf')`))
      .rejects.toThrow(/row-level security/)
    const b = await db.client.findUniqueOrThrow({ where: { id: fx().b.clientId } })
    expect(b.firstName).toBe("Synthetic")
    expect((await db.loan.findUniqueOrThrow({ where: { id: fx().b.loanId } })).collectionsNotes).not.toBe("Mutated")
  })

  it("an interactive and a batch transaction opened as lender A are bound to lender A", async () => {
    const itx = await asA(() => app.$transaction(async (tx) => countSameIdRaw(tx as unknown as typeof app)))
    expect(clientCount(itx)).toBe(1)
    const [batch] = await asA(() => app.$transaction([countSameIdRaw(app)]))
    expect(clientCount(batch)).toBe(1)
  })

  const tenantOf = (tx: typeof app) =>
    tx.$queryRaw<{ t: string }[]>`SELECT "tenantId" AS t FROM "Client" WHERE "idNumber" = ${fx().idNumber}`
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it("refuses lender B's frame inside a transaction opened as lender A, and rolls it back", async () => {
    const before = await db.client.findUniqueOrThrow({ where: { id: fx().a.clientId } })
    await expect(asA(() => app.$transaction(async (tx) => {
      const db2 = tx as unknown as typeof app
      await db2.$executeRaw`UPDATE "Client" SET "firstName" = 'InTx' WHERE "id" = ${fx().a.clientId}`
      return runWithTenant(fx().b.tenantId, async () => await tenantOf(db2))
    }))).rejects.toBeInstanceOf(RlsTransactionTenantError)
    expect(await db.client.findUniqueOrThrow({ where: { id: fx().a.clientId } })).toEqual(before)
  })

  it("binds a transaction opened with no frame to the first tenant frame inside it", async () => {
    const seen = await app.$transaction(async (tx) => {
      const db2 = tx as unknown as typeof app
      const inner = await runWithTenant(fx().b.tenantId, async () => await tenantOf(db2))
      const after = await tenantOf(db2) // the frame has exited; the binding stays (it only narrows)
      return [inner, after].map((rows) => rows.map((r) => r.t))
    })
    expect(seen).toEqual([[fx().b.tenantId], [fx().b.tenantId]])
  })

  it("keeps two concurrent requests for lenders A and B apart through interleaved awaits", async () => {
    // A pool of one connection would serialise them; this suite's pool is
    // one, so a second client gives the two requests a connection each.
    const other = createAppPrismaClient(roleUrl(password))
    try {
      const request = (client: typeof app, tenantId: string, waits: number[]) =>
        runWithTenant(tenantId, () => client.$transaction(async (tx) => {
          const seen: string[] = []
          for (const w of waits) {
            for (let i = 0; i < w; i++) await tick()
            seen.push(...(await tenantOf(tx as unknown as typeof app)).map((r) => r.t))
          }
          return seen
        }))
      const [a, b] = await Promise.all([request(app, fx().a.tenantId, [1, 3, 1]), request(other, fx().b.tenantId, [2, 1, 2])])
      expect(a).toEqual([fx().a.tenantId, fx().a.tenantId, fx().a.tenantId])
      expect(b).toEqual([fx().b.tenantId, fx().b.tenantId, fx().b.tenantId])
    } finally {
      await other.$disconnect()
    }
  })

  it("the system context (withoutTenantScope) sees both lenders, and no setting outlives its transaction", async () => {
    expect(clientCount(await withoutTenantScope(async () => await countSameIdRaw(app)))).toBe(2)
    await asA(() => countSameIdRaw(app))
    // Same single pooled connection: no frame now, so nothing may be set.
    const [after] = await app.$queryRaw<{ t: string | null; b: string | null }[]>`
      SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.rls_bypass', true) AS b`
    expect([after.t ?? "", after.b ?? ""]).toEqual(["", ""])
  })

  it("strict mode: with no context nothing is visible; the system context still is", async () => {
    await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} SET app.rls_strict = 'on'`)
    const strict = createAppPrismaClient(roleUrl(password))
    try {
      expect(clientCount(await countSameIdRaw(strict))).toBe(0)
      expect(clientCount(await withoutTenantScope(async () => await countSameIdRaw(strict)))).toBe(2)
      expect(clientCount(await asA(() => countSameIdRaw(strict)))).toBe(1)
    } finally {
      await strict.$disconnect()
      await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} RESET app.rls_strict`)
    }
  })

  it("permissive default: with no context and no strict mode, code without a frame keeps working", async () => {
    expect(clientCount(await countSameIdRaw(app))).toBe(2)
  })
})
