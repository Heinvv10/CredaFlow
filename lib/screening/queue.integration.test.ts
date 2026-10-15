/**
 * Real-Postgres proof of the review queue (N5): only undecided matches of each
 * subject's latest run, never a confirmed sanctions match (that is a block),
 * oldest first, paginated with the true total — nothing starves.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/queue.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runScreening } from "./run"
import { listActiveBlocks, listReviewQueue, REVIEW_QUEUE_PAGE_SIZE } from "./queue"

const RUN = process.env.RUN_SCREENING_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `tenant_queue_${token}`
const officer = { id: `officer_q_${token}`, email: `oq-${token}@test.invalid` }

async function screened(lastName: string): Promise<string> {
  const id = `q_${randomUUID().slice(0, 10)}`
  await db.client.create({ data: {
    id, tenantId, reference: `REF-${id}`, idNumber: `ID-${id}`, firstName: "Synthetic", lastName, email: `${id}@test.invalid`, phone: "+27820000000",
  } })
  await runScreening({ tenantId, subject: { clientId: id }, trigger: "MANUAL", actor: officer })
  return id
}

suite("review queue against Postgres", () => {
  const pep: string[] = []
  let sanctioned = ""
  let rescreened = ""
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `queue-${token}`, name: "Queue test" } })
    await db.tenantConfig.create({ data: { tenantId, screeningProvider: "simulated" } })
    await db.user.create({ data: { id: officer.id, tenantId, email: officer.email, password: "x", role: "CREDIT_OFFICER" } })
    for (let i = 0; i <= REVIEW_QUEUE_PAGE_SIZE; i++) pep.push(await screened("Fixture-Pep"))
    sanctioned = await screened("Fixture-Sanction")
    rescreened = await screened("Fixture-Media")
    await runScreening({ tenantId, subject: { clientId: rescreened }, trigger: "MANUAL", actor: officer })
  })
  afterAll(async () => db.$disconnect())

  it("pages through every open match, oldest first, with the true total", async () => {
    const first = await listReviewQueue(tenantId, 1)
    const second = await listReviewQueue(tenantId, 2)
    const expected = pep.length + 1
    expect(first.total).toBe(expected)
    expect(first.items).toHaveLength(REVIEW_QUEUE_PAGE_SIZE)
    expect(second.items).toHaveLength(expected - REVIEW_QUEUE_PAGE_SIZE)
    expect(first.items[0].clientId).toBe(pep[0])
    const all = [...first.items, ...second.items]
    expect(new Set(all.map((i) => i.checkId)).size).toBe(expected)
  })

  it("shows only the latest run's match for a re-screened subject, and never a confirmed sanctions match", async () => {
    const all = [...(await listReviewQueue(tenantId, 1)).items, ...(await listReviewQueue(tenantId, 2)).items]
    expect(all.filter((i) => i.clientId === rescreened)).toHaveLength(1)
    const latestRun = await db.screeningCheck.findFirst({ where: { tenantId, clientId: rescreened }, orderBy: { createdAt: "desc" }, select: { runId: true } })
    const shown = all.find((i) => i.clientId === rescreened)!
    expect((await db.screeningCheck.findUnique({ where: { id: shown.checkId } }))?.runId).toBe(latestRun?.runId)
    expect(all.some((i) => i.clientId === sanctioned)).toBe(false)
    expect((await listActiveBlocks(tenantId)).some((b) => b.clientId === sanctioned)).toBe(true)
  })
})
