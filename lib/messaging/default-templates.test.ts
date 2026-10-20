import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { SEED_BRAND_TOKEN } from "@/lib/whatsapp/template-vars"
import { DEFAULT_MESSAGE_TEMPLATES, seedDefaultMessageTemplates } from "./default-templates"

type Row = { tenantId: string; key: string | null; event: string; channel: string; body: string; [k: string]: unknown }
type Where = { tenantId: string; OR: ({ key: string } | { event: string; channel: string })[] }

/**
 * An in-memory MessageTemplate table that enforces both of the real table's
 * uniques, (tenantId, key) and (tenantId, event, channel), the way Postgres
 * does: a create that collides throws P2002. Every call is recorded, so a test
 * can prove nothing was ever updated.
 */
function fakeDb(existing: Row[] = []) {
  const rows = existing.map((r) => ({ ...r }))
  const calls: { method: string; args: unknown }[] = []
  const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
  const create = (data: Row) => {
    const clash = rows.some((r) => r.tenantId === data.tenantId
      && ((data.key != null && r.key === data.key) || (r.event === data.event && r.channel === data.channel)))
    if (clash) throw p2002()
    rows.push({ ...data })
    return data
  }
  const matches = (r: Row, w: Where) => r.tenantId === w.tenantId
    && w.OR.some((o) => ("key" in o ? r.key === o.key : r.event === o.event && r.channel === o.channel))
  const messageTemplate = {
    findFirst: async (args: { where: Where }) => { calls.push({ method: "findFirst", args }); return rows.find((r) => matches(r, args.where)) ?? null },
    findMany: async (args: { where: { tenantId: string } }) => { calls.push({ method: "findMany", args }); return rows.filter((r) => r.tenantId === args.where.tenantId) },
    // ON CONFLICT DO NOTHING on both uniques.
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      calls.push({ method: "createMany", args })
      for (const data of args.data) {
        const clash = rows.some((r) => r.tenantId === data.tenantId && ((data.key != null && r.key === data.key) || (r.event === data.event && r.channel === data.channel)))
        if (clash && !args.skipDuplicates) throw p2002()
        if (!clash) rows.push({ ...data })
      }
      return { count: args.data.length }
    },
    create: async (args: { data: Row }) => { calls.push({ method: "create", args }); return create(args.data) },
    // Prisma's upsert: update when (tenantId, key) exists, else create.
    upsert: async (args: { where: { tenantId_key: { tenantId: string; key: string } }; create: Row }) => {
      calls.push({ method: "upsert", args })
      const { tenantId, key } = args.where.tenantId_key
      return rows.find((r) => r.tenantId === tenantId && r.key === key) ?? create(args.create)
    },
    update: async (args: unknown) => { calls.push({ method: "update", args }); throw new Error("update must never be called") },
  }
  return { rows, calls, db: { messageTemplate } as unknown as Parameters<typeof seedDefaultMessageTemplates>[0] }
}

const created = (calls: { method: string; args: unknown }[]) =>
  calls.flatMap((c) => (c.method === "createMany" ? (c.args as { data: Row[] }).data : []))

describe("default message templates", () => {
  it("name no lender: the brand is a seed-time token", () => {
    expectNoOtherLender(JSON.stringify(DEFAULT_MESSAGE_TEMPLATES))
  })

  it("do not seed the statutory section129_email body", () => {
    expect(DEFAULT_MESSAGE_TEMPLATES.map((t) => t.key)).not.toContain("section129_email")
  })

  it("have unique keys and unique (event, channel) pairs, as the table's two uniques require", () => {
    const keys = DEFAULT_MESSAGE_TEMPLATES.map((t) => t.key)
    const pairs = DEFAULT_MESSAGE_TEMPLATES.map((t) => `${t.event}/${t.channel}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})

describe("seedDefaultMessageTemplates", () => {
  it("creates every default for the tenant with its brand", async () => {
    const { calls, db } = fakeDb()
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)

    const rows = created(calls)
    expect(rows.map((r) => r.key).sort()).toEqual(DEFAULT_MESSAGE_TEMPLATES.map((t) => t.key).sort())
    for (const r of rows) {
      expect(r.tenantId).toBe("tenant-acme")
      expect(JSON.stringify(r)).not.toContain(SEED_BRAND_TOKEN)
    }
    const reengage = rows.find((r) => r.key === "agent_reengagement_whatsapp")!
    expect(reengage.body).toContain("your enquiry with Acme Lending.")
    expect(reengage.bodyTemplate).toBe(reengage.body)
    const submitted = rows.find((r) => r.key === "application_submitted_whatsapp")!
    expect(submitted.body).toContain("Thank you for choosing Acme Lending.")
    expect(submitted.bodyTemplate).toBe(submitted.body)
  })

  it("skips a default whose (event, channel) the tenant already holds under another or no key, and still seeds the rest", async () => {
    const [first, second] = DEFAULT_MESSAGE_TEMPLATES
    // Shapes the Settings UI writes (no key) and an operator re-key.
    const existing: Row[] = [
      { tenantId: "tenant-acme", key: null, event: first.event, channel: first.channel, body: "operator body" },
      { tenantId: "tenant-acme", key: "renamed", event: second.event, channel: second.channel, body: "renamed body" },
    ]
    const { rows, calls, db } = fakeDb(existing)
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)

    expect(created(calls).map((r) => r.key).sort()).toEqual(DEFAULT_MESSAGE_TEMPLATES.slice(2).map((t) => t.key).sort())
    expect(rows.slice(0, 2)).toEqual(existing)
    expect(calls.filter((c) => c.method === "update" || c.method === "upsert")).toEqual([])
  })

  it("skips a default whose key the tenant already holds, even under another (event, channel)", async () => {
    const [first] = DEFAULT_MESSAGE_TEMPLATES
    const existing: Row[] = [{ tenantId: "tenant-acme", key: first.key, event: "custom_event", channel: "SMS", body: "edited" }]
    const { rows, calls, db } = fakeDb(existing)
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)

    expect(created(calls).map((r) => r.key)).not.toContain(first.key)
    expect(created(calls)).toHaveLength(DEFAULT_MESSAGE_TEMPLATES.length - 1)
    expect(rows[0]).toEqual(existing[0])
  })

  it("is two queries when nothing is missing, so the nightly run can afford every tenant", async () => {
    const { calls, db } = fakeDb()
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)
    calls.length = 0
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)
    expect(calls.map((c) => c.method)).toEqual(["findMany"])
  })

  it("matches existing rows only within the same tenant", async () => {
    const [first] = DEFAULT_MESSAGE_TEMPLATES
    const { calls, db } = fakeDb([{ tenantId: "tenant-other", key: first.key, event: first.event, channel: first.channel, body: "x" }])
    await seedDefaultMessageTemplates(db, "tenant-acme", ACME_LENDER.tradingName)
    expect(created(calls)).toHaveLength(DEFAULT_MESSAGE_TEMPLATES.length)
  })

  it("refuses a blank brand rather than storing an unfillable row", async () => {
    const { calls, db } = fakeDb()
    await expect(seedDefaultMessageTemplates(db, "tenant-acme", "  ")).rejects.toThrow(/lenderName/)
    expect(calls).toHaveLength(0)
  })
})
