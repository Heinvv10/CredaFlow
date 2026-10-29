/**
 * Real-Postgres proof that a backup restored the way the restore paths do it (pg_restore --no-owner
 * --no-acl, into a new database) keeps its hash chains verifiable (the rows come back with the
 * timestamps they were chained with), loses the audit protections that live in ownership and ACLs,
 * and gets them back from audit_reassert_protections(), which the restore scripts run.
 *
 *   RUN_DB_IT=1 IT_CONTAINER=<the it-db.sh container> AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://<superuser>... \
 *     npx vitest run lib/audit/restore-protections.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { auditFixture } from "./it-fixture.test-helpers"

const container = process.env.IT_CONTAINER
const suite = process.env.RUN_DB_IT === "1" && container ? describe : describe.skip

suite("a restored database", () => {
  const fx = auditFixture(["r"])
  const { write, chain, redact, rows, ids } = fx
  const scratch = `restore_${randomUUID().replaceAll("-", "").slice(0, 10)}`
  const R = ids.r
  let restored: PrismaClient

  const sh = (cmd: string) => execFileSync("docker", ["exec", container!, "sh", "-c", cmd], { encoding: "utf8" })
  const url = () => {
    const u = new URL(process.env.DATABASE_URL as string)
    u.pathname = `/${scratch}`
    return u.toString()
  }

  beforeAll(async () => {
    await fx.setup()
    for (let i = 1; i <= 4; i++) await write(R, i)
    await chain(R)
    const [first] = await rows(R)
    await redact(first.id, ["userEmail"])
    for (let i = 5; i <= 6; i++) await write(R, i)
    await chain(R)
    sh(`pg_dump -U postgres -Fc --no-owner --no-acl -f /tmp/${scratch}.dump postgres`)
    // Not --exit-on-error: this database is shared with every other suite, which leave rows behind that break foreign
    // keys on tables unrelated to the audit (a backup of a healthy database restores clean; the restore scripts keep
    // --exit-on-error). What this proves is checked below, not by the exit status.
    sh(`createdb -U postgres ${scratch} && (pg_restore -U postgres -d ${scratch} --no-owner --no-acl /tmp/${scratch}.dump 2>/dev/null || true)`)
    restored = new PrismaClient({ datasourceUrl: url() })
  }, 120_000)

  afterAll(async () => {
    await restored?.$disconnect()
    sh(`dropdb -U postgres --force --if-exists ${scratch}; rm -f /tmp/${scratch}.dump`)
    await fx.teardown()
  })

  it("keeps its chains verifiable: the rows come back with the times they were chained with, redactions included", async () => {
    const { verifyAuditChains } = await import("./chain-verify")
    expect(await verifyAuditChains(restored, { chainKey: R, mode: "full" })).toMatchObject({ ok: true, rowsChecked: 7 })
  })

  it("loses the redaction function's owner and the REVOKE FROM PUBLIC, and gets both back from audit_reassert_protections()", async () => {
    const state = () => restored.$queryRaw<Array<{ owner: string; publicExecutes: number }>>`
      SELECT pg_get_userbyid((SELECT proowner FROM pg_proc WHERE proname = 'audit_log_redact')) AS owner,
             (SELECT count(*)::int FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.proname LIKE 'audit\\_%' AND p.proname NOT IN ('audit_log_append_only', 'audit_evidence_append_only') AND a.grantee = 0) AS "publicExecutes"`
    const [lost] = await state()
    expect(lost.owner).not.toBe("audit_redactor")
    expect(lost.publicExecutes).toBeGreaterThan(0)

    await restored.$executeRaw`SELECT public.audit_reassert_protections()`
    const [back] = await state()
    expect(back).toEqual({ owner: "audit_redactor", publicExecutes: 0 })
    // And the redactor path works again in the restored database.
    const [row] = await restored.auditLog.findMany({ where: { tenantId: R, entityId: "e2" } })
    const { columnDigest } = await import("./chain-hash")
    await restored.$executeRaw`SELECT public.audit_log_redact(${row.id}, ARRAY['ipAddress']::text[], 'POPIA erasure ref 55', 'it-op', ${JSON.stringify({ ipAddress: columnDigest("ipAddress", row.ipAddress ?? "") })}::jsonb)`
    const { verifyAuditChains } = await import("./chain-verify")
    expect(await verifyAuditChains(restored, { chainKey: R, mode: "full" })).toMatchObject({ ok: true })
  })

  it("is idempotent: running it again changes nothing", async () => {
    await restored.$executeRaw`SELECT public.audit_reassert_protections()`
    await restored.$executeRaw`SELECT public.audit_reassert_protections()`
    const [r] = await restored.$queryRaw<Array<{ owner: string }>>`SELECT pg_get_userbyid((SELECT proowner FROM pg_proc WHERE proname = 'audit_log_redact')) AS owner`
    expect(r.owner).toBe("audit_redactor")
  })
})
