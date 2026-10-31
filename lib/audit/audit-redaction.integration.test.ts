/**
 * Real-Postgres proof of documented redaction (POPIA) and the retention policy checks.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/audit-redaction.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { auditFixture, suite } from "./it-fixture.test-helpers"

suite("audit-redaction", () => {
  const fx = auditFixture(["a"])
  const { db, token, write, rows, chain, verify, tamper, tenant, redact, ids } = fx
  const { a: A } = ids
  beforeAll(fx.setup)
  afterAll(fx.teardown)

  /** The row now equals `before` with exactly `cols` set to null, and nothing else changed. */
  const expectOnlyNulled = async (before: Awaited<ReturnType<typeof db.auditLog.create>>, cols: Array<"userEmail" | "ipAddress" | "oldValue" | "newValue">) => {
    const after = await db.auditLog.findUniqueOrThrow({ where: { id: before.id } })
    expect(after).toEqual({ ...before, ...Object.fromEntries(cols.map((c) => [c, null])) })
  }

  describe("documented redaction (POPIA)", () => {
    let N = ""
    it("nulls the personal data, keeps the chain verifiable, records the digests and writes its own audit row", async () => {
      N = await tenant("n")
      for (let i = 1; i <= 4; i++) await write(N, i)
      await chain(N)
      const [target] = await rows(N)
      await redact(target.id, ["userEmail", "newValue"])
      const after = await db.auditLog.findUniqueOrThrow({ where: { id: target.id } })
      expect(after).toMatchObject({ userEmail: null, newValue: null, ipAddress: "10.0.0.1" })
      expect(after.oldValue).toEqual(target.oldValue)
      expect(await verify(N)).toMatchObject({ ok: true })
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: N, action: "AUDIT_ROW_REDACTED" } })
      expect(audit).toMatchObject({ entityId: target.id, newValue: expect.objectContaining({ columns: ["userEmail", "newValue"], operator: "it-operator" }) })
      await chain(N)
      expect(await verify(N)).toMatchObject({ ok: true, rowsChecked: 5 })

      // The legacy message-evidence guards validate new audit rows. They must not
      // re-read Message as the restricted audit_redactor role during a later POPIA
      // redaction (and must not reconstruct the value being erased).
      const messageAudit = await db.auditLog.create({
        data: {
          tenantId: N,
          action: "AUDIT_IT",
          entity: "Message",
          entityId: `missing-message-${token}`,
          userEmail: "m@it.invalid",
          ipAddress: "10.0.0.2",
          oldValue: { personal: "kept" },
          newValue: { personal: "erase me" },
        },
      })
      await redact(messageAudit.id, ["newValue"])
      // Only the redacted column changed: action, entity, entityId, tenant, user, the other
      // personal-data columns and createdAt are exactly as inserted.
      await expectOnlyNulled(messageAudit, ["newValue"])

      // Deterministically, whatever the session's plan-cache history: a generic plan keeps
      // the guards' EXISTS on "Message" in the plan, so Postgres checks SELECT on Message
      // when the redaction writes its own AUDIT_ROW_REDACTED row as audit_redactor. The
      // guards must not run for that row at all (this failed in a long CI shard only).
      for (const entity of ["Thing", "Message"]) {
        const row = await db.auditLog.create({
          data: { tenantId: N, action: "AUDIT_IT", entity, entityId: `generic-plan-${entity}-${token}`, newValue: { personal: "erase me" } },
        })
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`
          await redact(row.id, ["newValue"], undefined, undefined, tx)
        })
        await expectOnlyNulled(row, ["newValue"])
      }

      // Another column later; the same column twice is refused.
      await redact(target.id, ["ipAddress"])
      expect((await verify(N)).ok).toBe(true)
      await expect(redact(target.id, ["ipAddress"])).rejects.toThrow(/already redacted/)
      // Redaction does not hide a later edit of what is left.
      await tamper(`UPDATE "AuditLog" SET "oldValue" = '{"n": 5}' WHERE id = '${target.id}'`)
      expect((await verify(N)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 1 })])
    })

    it("refuses a thin reason, an unknown column, a missing row and the immutable NCA quotation row; PUBLIC cannot execute it", async () => {
      await write(N, 20)
      const [row] = await db.auditLog.findMany({ where: { tenantId: N, entityId: "e20" } })
      await expect(redact(row.id, ["userEmail"], "short")).rejects.toThrow(/reason/)
      await expect(redact(row.id, ["action"] as never)).rejects.toThrow(/columns|keyed digest/)
      await expect(redact("no-such-row", ["userEmail"])).rejects.toThrow(/no such audit row/)
      await db.auditLog.create({ data: { id: `nca-${token}`, tenantId: N, action: "ASSET_NCA_QUOTE_ISSUED", entity: "Thing", userEmail: "x@it.invalid" } })
      await expect(redact(`nca-${token}`, ["userEmail"])).rejects.toThrow()
      const [pub] = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.proname = 'audit_log_redact' AND a.grantee = 0`
      expect(pub.n).toBe(0)
    })
  })

  describe("retention policy", () => {
    it("refuses less than 12 months retained, a hot window under 3 months or over the retention, and plaintext secrets", async () => {
      const create = (data: Record<string, unknown>) => db.auditPolicy.create({ data: { tenantId: A, ...data } as never })
      await expect(create({ retentionMonths: 11 })).rejects.toThrow(/AuditPolicy_retention_floor/)
      await expect(create({ hotMonths: 2 })).rejects.toThrow(/AuditPolicy_hot_window/)
      await expect(create({ retentionMonths: 12, hotMonths: 13 })).rejects.toThrow(/AuditPolicy_hot_window/)
      await expect(create({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "http://plain.example.invalid" })).rejects.toThrow(/AuditPolicy_siem_target/)
      await expect(create({ siemSealedToken: "plaintext" })).rejects.toThrow(/AuditPolicy_siem_secrets_sealed/)
    })
  })
})
