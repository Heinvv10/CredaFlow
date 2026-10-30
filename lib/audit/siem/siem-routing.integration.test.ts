/**
 * Real-Postgres proof of where the audit trail goes when a lender changes its policy: the backlog drains to the old destination, rows chained later too, the anchor, credential rotation and pruning.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/siem/siem-routing.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { saveAuditPolicy } from "./policy"
import { siemFixture } from "./siem-it.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("siem-routing", () => {
  const fx = siemFixture()
  const { db, token, T0, at, tenant, enable, write, chain, outbox, recorder, deliver } = fx
  beforeAll(fx.setup)
  afterAll(fx.teardown)

  it("sends the backlog to the old destination when forwarding is switched off, rows chained later included, and queues nothing new", async () => {
    const t = await tenant("off")
    await enable(t, "https://old.example.invalid/ingest")
    for (let i = 1; i <= 3; i++) await write(t, i)
    await chain(t)
    await write(t, 4) // committed before the switch-off, chained after it
    await db.auditPolicy.update({ where: { tenantId: t }, data: { siemEnabled: false } })
    await chain(t)
    await write(t, 5) // after: nothing to forward
    await chain(t)
    const rec = recorder()
    await deliver(rec.send, T0)
    expect(rec.calls.map((c) => c.url)).toEqual(["https://old.example.invalid/ingest"])
    expect(rec.calls[0].events.map((e) => e.entityId)).toEqual(["e1", "e2", "e3", "e4"])
    expect((await outbox(t)).every((o) => o.sentAt !== null)).toBe(true)
    expect(await db.auditSiemDelivery.count({ where: { tenantId: t } })).toBe(4)
  })

  it("prunes an unstamped leftover of a lender that is not forwarding, and records the pruning as an audit row", async () => {
    const t = await tenant("prune")
    await write(t, 1)
    await chain(t)
    const [row] = await db.auditLog.findMany({ where: { tenantId: t } })
    await db.auditSiemOutbox.create({ data: { tenantId: t, kind: "EVENT", auditLogId: row.id } })
    const rec = recorder()
    await deliver(rec.send, T0)
    expect(rec.calls).toHaveLength(0)
    expect(await outbox(t)).toEqual([])
    const pruned = await db.auditLog.findMany({ where: { tenantId: t, action: "AUDIT_SIEM_QUEUE_PRUNED" } })
    expect(pruned.map((r) => r.newValue)).toEqual([{ pruned: 1 }])
  })

  it("routes a policy change that only rotates the credential to the old snapshot without rerouting the backlog", async () => {
    const t = await tenant("rot")
    const actor = await db.user.create({ data: { id: `siem-r-${token}`, email: `siem-r-${token}@it.invalid`, password: "x", tenantId: t, role: "ADMIN" } })
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }]
    const save = (input: Record<string, unknown>) => runWithTenant(t, () => saveAuditPolicy(t, { id: actor.id, email: actor.email }, input, { resolve }))
    await save({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://same.example.invalid/ingest", siemToken: "first-token" })
    await write(t, 1)
    await chain(t)
    await save({ siemToken: "second-token" })
    const [rev] = await db.auditPolicyRevision.findMany({ where: { tenantId: t }, orderBy: { id: "desc" }, take: 1 })
    expect(rev).toMatchObject({ oldEnabled: true, newEnabled: true, rerouted: false })
    const pending = await outbox(t)
    expect(pending.filter((o) => o.targetSnapshot !== null).map((o) => o.kind)).toEqual(["EVENT"]) // the change row only
    expect(pending.find((o) => o.kind === "EVENT" && o.targetSnapshot === null)).toBeDefined() // the backlog stays on the current stream
  })

  it("sends an anchor (the chain head) when forwarding starts, and the policy change to the destination it left", async () => {
    const t = await tenant("pol")
    const actor = await db.user.create({ data: { id: `siem-u-${token}`, email: `siem-u-${token}@it.invalid`, password: "x", tenantId: t, role: "ADMIN" } })
    for (let i = 1; i <= 3; i++) await write(t, i)
    await chain(t)
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }]
    const save = (input: Record<string, unknown>) =>
      runWithTenant(t, () => saveAuditPolicy(t, { id: actor.id, email: actor.email }, input, { resolve }))

    await save({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://old.example.invalid/ingest", siemToken: "s3cret" })
    expect((await outbox(t)).map((o) => o.kind)).toContain("ANCHOR")
    await chain(t) // links the policy row (and queues it: forwarding is on)
    const anchor = recorder()
    await deliver(anchor.send, T0)
    const started = anchor.calls.flatMap((c) => c.events).find((e) => e.action === "AUDIT_FORWARDING_STARTED")
    const [head] = await db.$queryRaw<Array<{ seq: number; rowHash: string }>>`SELECT "seq", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${t} ORDER BY "seq" DESC LIMIT 1`
    expect(started?.chain.seq).toBeGreaterThanOrEqual(3)
    expect(started?.chain.seq).toBeLessThanOrEqual(head.seq)
    expect(JSON.stringify(anchor.calls)).not.toContain("s3cret")

    // Redirect the feed: the row recording it goes to the OLD destination, the new one starts with an anchor.
    await save({ siemUrl: "https://new.example.invalid/ingest" })
    await chain(t)
    const moved = recorder()
    await deliver(moved.send, at(10))
    const toOld = moved.calls.filter((c) => c.url === "https://old.example.invalid/ingest").flatMap((c) => c.events)
    expect(toOld.map((e) => e.action)).toEqual(["AUDIT_POLICY_UPDATED"])
    expect(JSON.stringify(toOld)).not.toContain("new.example.invalid/ingest?")
    const toNew = moved.calls.filter((c) => c.url === "https://new.example.invalid/ingest").flatMap((c) => c.events)
    expect(toNew.map((e) => e.action)).toContain("AUDIT_FORWARDING_STARTED")
    expect(toNew.map((e) => e.action)).not.toContain("AUDIT_POLICY_UPDATED")

    // Switch it off: the row recording that goes to the destination it was switched off from.
    await save({ siemEnabled: false })
    await chain(t)
    const off = recorder()
    await deliver(off.send, at(20))
    expect(off.calls.flatMap((c) => c.events).map((e) => e.action)).toEqual(["AUDIT_POLICY_UPDATED"])
    expect(off.calls[0].url).toBe("https://new.example.invalid/ingest")
  })

  it("drains what was queued for the old destination to it, in order, before the change event; the new one gets only its anchor", async () => {
    const t = await tenant("backlog")
    const actor = await db.user.create({ data: { id: `siem-b-${token}`, email: `siem-b-${token}@it.invalid`, password: "x", tenantId: t, role: "ADMIN" } })
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }]
    const save = (input: Record<string, unknown>) =>
      runWithTenant(t, () => saveAuditPolicy(t, { id: actor.id, email: actor.email }, input, { resolve }))
    await save({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://old.example.invalid/ingest" })
    for (let i = 1; i <= 3; i++) await write(t, i)
    await chain(t) // three events and the first policy row are queued for the old destination, not yet sent

    await save({ siemUrl: "https://new.example.invalid/ingest" })
    await chain(t)
    const rec = recorder()
    await deliver(rec.send, T0)
    const toOld = rec.calls.filter((c) => c.url === "https://old.example.invalid/ingest").flatMap((c) => c.events)
    const seqs = toOld.flatMap((e) => (e.chain.seq === null ? [] : [e.chain.seq]))
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(toOld.filter((e) => e.action === "LOAN_NOTE_ADDED")).toHaveLength(3)
    expect(toOld.at(-1)?.action).toBe("AUDIT_POLICY_UPDATED")
    const toNew = rec.calls.filter((c) => c.url === "https://new.example.invalid/ingest").flatMap((c) => c.events)
    expect(toNew.map((e) => e.action)).toEqual(["AUDIT_FORWARDING_STARTED"])
  })
})
