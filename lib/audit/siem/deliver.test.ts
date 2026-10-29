import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OutboxSource } from "@/lib/audit/store"

// An in-memory outbox behind the store's functions: the ordering, backoff and poison rules are deliver.ts's own.
const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; kind: string; auditLogId: string | null; checkpointId: string | null; seq: number | null; targetSnapshot: unknown; attempts: number; nextAttemptAt: Date; createdAt: Date; sentAt: Date | null; deadAt: Date | null; lastError: string | null }>,
  lockHeld: false,
  policy: { siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null, siemUrl: "https://siem.example.invalid/ingest", siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null } as Record<string, unknown> | undefined,
  pruned: 0,
}))

const pending = () => state.rows.filter((r) => !r.sentAt && !r.deadAt)

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: <T,>(fn: () => Promise<T>) => fn() }))
vi.mock("./policy", () => ({
  siemTarget: (p: { siemUrl: string | null }) => ({ transport: "HTTPS_JSON", host: null, port: null, url: p.siemUrl, token: null, caCertPem: null, clientCertPem: null, clientKeyPem: null }),
}))
vi.mock("@/lib/audit/store", () => ({
  dueTenants: async (_db: unknown, now: Date) => [...new Set(pending().filter((r) => r.nextAttemptAt <= now).map(() => "t1"))],
  streamRows: async (_db: unknown, _t: string, limit: number) => pending().filter((r) => !r.targetSnapshot).slice(0, limit),
  snapshotRows: async (_db: unknown, _t: string, limit: number) => pending().filter((r) => r.targetSnapshot).slice(0, limit),
  outboxSources: async (_db: unknown, ids: string[]): Promise<OutboxSource[]> => ids.map((id) => ({
    id, tenantId: "t1", userId: null, action: "LOAN_NOTE_ADDED", entity: "Loan", entityId: "l1", oldValue: null, newValue: null, ipAddress: null,
    createdAt: new Date("2026-10-29T10:00:00Z"), linkSeq: Number(id.slice(1)), linkRowHash: "a".repeat(64), linkPrevHash: "b".repeat(64),
  })),
  markOutbox: async (_db: unknown, ids: number[], mark: "sent" | "retry" | "dead", error: string | null, at: Date) => {
    for (const r of state.rows.filter((x) => ids.includes(x.id))) {
      if (mark === "sent") r.sentAt = at
      else { r.attempts++; r.lastError = error; if (mark === "dead") r.deadAt = at; else r.nextAttemptAt = at }
    }
  },
  pruneUnsent: async () => { state.pruned++; state.rows = state.rows.filter((r) => r.sentAt || r.deadAt || r.targetSnapshot) },
  purgeSent: async () => undefined,
  oldestPending: async () => pending()[0]?.createdAt ?? null,
  checkpointById: async () => null,
  linkHashAt: async () => "c".repeat(64),
  chainHead: async () => null,
}))

import { backoffSeconds, deliverSiemOutbox, type SiemSender } from "./deliver"

const NOW = new Date("2026-10-29T12:00:00Z")
const tx = {
  $queryRaw: async (strings: TemplateStringsArray) =>
    strings.join("").includes("pg_try_advisory_xact_lock") ? [{ ok: !state.lockHeld }] : state.policy ? [state.policy] : [],
}
const db = { $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as never

const queue = (n: number, extra: Partial<(typeof state.rows)[number]> = {}) => {
  for (let i = 1; i <= n; i++) {
    state.rows.push({
      id: state.rows.length + 1, kind: "EVENT", auditLogId: `a${state.rows.length + 1}`, checkpointId: null, seq: state.rows.length + 1, targetSnapshot: null,
      attempts: 0, nextAttemptAt: new Date(NOW.getTime() - 1000), createdAt: new Date(NOW.getTime() - 60_000), sentAt: null, deadAt: null, lastError: null, ...extra,
    })
  }
}
const recorder = (answer: (seqs: Array<number | null>) => { ok: boolean; permanent?: boolean; error?: string } = () => ({ ok: true })) => {
  const calls: Array<Array<number | null>> = []
  const send: SiemSender = async (_target, events) => {
    const seqs = events.map((e) => e.chain.seq)
    calls.push(seqs)
    const r = answer(seqs)
    return r.ok ? { ok: true, error: null } : { ok: false, error: (r.error ?? "siem_unavailable") as never, ...(r.permanent ? { permanent: true } : {}) }
  }
  return { calls, send }
}

beforeEach(() => {
  state.rows = []
  state.lockHeld = false
  state.pruned = 0
  state.policy = { siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null, siemUrl: "https://siem.example.invalid/ingest", siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null }
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("SIEM delivery backoff", () => {
  it("doubles from 30 seconds and stops at an hour", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240])
    expect(backoffSeconds(20)).toBe(3600)
  })
})

describe("deliverSiemOutbox", () => {
  it("sends the queued rows in order, with their chain seq, and marks them sent only after the SIEM acknowledged", async () => {
    queue(3)
    const rec = recorder()
    const result = await deliverSiemOutbox({ db, send: rec.send, now: NOW })
    expect(rec.calls).toEqual([[1, 2, 3]])
    expect(result).toMatchObject({ tenants: 1, sent: 3, dead: 0, failedBatches: 0, failedTenants: 0 })
    expect(state.rows.every((r) => r.sentAt)).toBe(true)
  })

  it("stops at the first failed batch, backs it off, and sends nothing behind it", async () => {
    queue(3)
    const rec = recorder(() => ({ ok: false }))
    const result = await deliverSiemOutbox({ db, send: rec.send, now: NOW })
    expect(rec.calls).toEqual([[1, 2, 3]])
    expect(result.failedBatches).toBe(1)
    expect(state.rows.map((r) => [r.attempts, r.sentAt])).toEqual([[1, null], [1, null], [1, null]])
    expect(state.rows[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + 30_000)

    const later = recorder()
    await deliverSiemOutbox({ db, send: later.send, now: new Date(NOW.getTime() + 10_000) })
    expect(later.calls).toEqual([]) // still backing off
    await deliverSiemOutbox({ db, send: later.send, now: new Date(NOW.getTime() + 31_000) })
    expect(later.calls).toEqual([[1, 2, 3]]) // the same rows again, same order
  })

  it("holds back every row behind one that is backing off, even rows that are due", async () => {
    queue(1, { nextAttemptAt: new Date(NOW.getTime() + 600_000), attempts: 2 })
    queue(2)
    const rec = recorder()
    await deliverSiemOutbox({ db, send: rec.send, now: NOW })
    expect(rec.calls).toEqual([])
  })

  it("splits a batch the SIEM refuses for its content until the bad row stands alone, and kills it after three tries", async () => {
    queue(4)
    const poison = (seqs: Array<number | null>) => (seqs.includes(3) ? { ok: false, permanent: true, error: "siem_rejected" } : { ok: true })
    for (let pass = 0; pass < 3; pass++) {
      const rec = recorder(poison)
      await deliverSiemOutbox({ db, send: rec.send, now: new Date(NOW.getTime() + pass * 4_000_000) })
    }
    expect(state.rows.map((r) => [r.sentAt !== null, r.deadAt !== null])).toEqual([[true, false], [true, false], [false, true], [true, false]])
    expect(state.rows[2].lastError).toBe("siem_rejected")
  })

  it("does not call a transient failure poison: a single row failing with a 5xx stays queued", async () => {
    queue(1)
    const rec = recorder(() => ({ ok: false, error: "siem_unavailable" }))
    for (let pass = 0; pass < 4; pass++) await deliverSiemOutbox({ db, send: rec.send, now: new Date(NOW.getTime() + pass * 4_000_000) })
    expect(state.rows[0]).toMatchObject({ sentAt: null, deadAt: null, attempts: 4 })
  })

  it("skips a lender another deliverer holds", async () => {
    queue(2)
    state.lockHeld = true
    const rec = recorder()
    await deliverSiemOutbox({ db, send: rec.send, now: NOW })
    expect(rec.calls).toEqual([])
    expect(state.rows.every((r) => !r.sentAt)).toBe(true)
  })

  it("sends a row stamped with the destination a lender left to that destination, apart from the current stream", async () => {
    const old = { ...(state.policy as object), siemUrl: "https://old.example.invalid/ingest" }
    queue(2, { targetSnapshot: old })
    queue(1)
    const urls: string[] = []
    const send: SiemSender = async (target, events) => { urls.push(`${target.url}:${events.map((e) => e.chain.seq).join(",")}`); return { ok: true, error: null } }
    await deliverSiemOutbox({ db, send, now: NOW })
    expect(urls).toEqual(["https://old.example.invalid/ingest:1,2", "https://siem.example.invalid/ingest:3"])
  })

  it("drops what is queued for the current destination when forwarding is off, but not rows owed to an old one", async () => {
    state.policy = { ...(state.policy as object), siemEnabled: false }
    queue(1)
    queue(1, { targetSnapshot: { ...(state.policy as object), siemUrl: "https://old.example.invalid/ingest" } })
    const rec = recorder()
    await deliverSiemOutbox({ db, send: rec.send, now: NOW })
    expect(state.pruned).toBe(1)
    expect(rec.calls).toEqual([[2]])
  })

  it("keeps going with the other lenders when one lender's delivery throws", async () => {
    queue(1)
    const rec = recorder()
    const failing = { $transaction: async () => { throw new Error("sealed secret no longer opens") } } as never
    const result = await deliverSiemOutbox({ db: failing, send: rec.send, now: NOW })
    expect(result).toMatchObject({ failedTenants: 1, sent: 0 })
  })
})
