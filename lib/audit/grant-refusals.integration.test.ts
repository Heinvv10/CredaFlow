/**
 * Real-Postgres proof that audit_grant_web / audit_grant_worker / audit_grant_runtime refuse a login
 * that could undo the protections, and that the health check sees the same roles.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://<superuser>... npx vitest run lib/audit/grant-refusals.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { ddl } from "./roles.test-helpers"
import { auditSetupWarnings } from "./deployment-check"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("audit grants refuse a login that could undo the protections", () => {
  const owner = new PrismaClient()
  const made: string[] = []
  const token = randomUUID().replaceAll("-", "").slice(0, 10)
  const WORKER_ENV = { AUDIT_CHAIN_KEY: "k".repeat(40), CRON_SCHEDULER: "on", APP_MODE: "all" }

  const role = async (suffix: string, attrs = "") => {
    const name = `cf_gr_${suffix}_${token}`
    await ddl(owner, `CREATE ROLE "${name}" LOGIN PASSWORD 'x' ${attrs}`)
    made.push(name)
    return name
  }
  const asRole = (name: string) => {
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = name
    url.password = "x"
    return new PrismaClient({ datasourceUrl: url.toString() })
  }
  const grants = (name: string) => [
    () => owner.$executeRaw`SELECT audit_grant_web(${name})`,
    () => owner.$executeRaw`SELECT audit_grant_worker(${name})`,
    () => owner.$executeRaw`SELECT audit_grant_runtime(${name})`,
  ]

  afterAll(async () => {
    for (const name of made) {
      await ddl(owner, `DROP OWNED BY "${name}"`).catch(() => undefined)
      await ddl(owner, `DROP ROLE IF EXISTS "${name}"`)
    }
    await owner.$disconnect()
  })

  it("refuses a missing role, a superuser, BYPASSRLS, CREATEROLE and CREATEDB", async () => {
    for (const grant of grants("no_such_role")) await expect(grant()).rejects.toThrow(/no role/)
    for (const [suffix, attrs] of [["su", "SUPERUSER"], ["rls", "BYPASSRLS"], ["cr", "CREATEROLE"], ["cd", "CREATEDB"]] as const) {
      for (const grant of grants(await role(suffix, attrs))) await expect(grant(), suffix).rejects.toThrow(/must not be a superuser|BYPASSRLS|CREATEROLE|CREATEDB/)
    }
  })

  it("refuses a role that holds CREATE on schema public, and a role that owns a table", async () => {
    const creator = await role("create")
    await ddl(owner, `GRANT CREATE ON SCHEMA public TO "${creator}"`)
    for (const grant of grants(creator)) await expect(grant()).rejects.toThrow(/CREATE on schema public/)
    await ddl(owner, `REVOKE CREATE ON SCHEMA public FROM "${creator}"`)

    const holder = await role("owns")
    await owner.$executeRawUnsafe(`CREATE TABLE public."cf_gr_t_${token}" (id int)`)
    await ddl(owner, `ALTER TABLE public."cf_gr_t_${token}" OWNER TO "${holder}"`)
    try {
      for (const grant of grants(holder)) await expect(grant()).rejects.toThrow(/owns tables/)
    } finally {
      await owner.$executeRawUnsafe(`DROP TABLE public."cf_gr_t_${token}"`)
    }
  })

  it("refuses a role that is a MEMBER of audit_redactor or of a table owner, and the health check warns when that role connects", async () => {
    const [me] = await owner.$queryRaw<Array<{ owner: string }>>`SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'AuditLog'`
    for (const parent of ["audit_redactor", me.owner]) {
      const member = await role(`m${parent.length}`)
      await ddl(owner, `GRANT "${parent}" TO "${member}"`)
      for (const grant of grants(member)) await expect(grant(), parent).rejects.toThrow(/is, or is a member of/)
      const connected = asRole(member)
      try {
        expect(await auditSetupWarnings(connected, WORKER_ENV), parent).toContain("audit_runtime_role_owns_tables")
      } finally {
        await connected.$disconnect()
      }
    }
  })

  it("the health check also warns of a role that can create roles or objects", async () => {
    const privileged = await role("priv", "CREATEROLE")
    const connected = asRole(privileged)
    try {
      expect(await auditSetupWarnings(connected, WORKER_ENV)).toContain("audit_runtime_role_privileged")
    } finally {
      await connected.$disconnect()
    }
  })
})
