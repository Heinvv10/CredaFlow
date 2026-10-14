/**
 * Real-Postgres proof of the signing OTP request budget: the per-subject and
 * per-client caps hold under concurrency (a serialised count + insert), not
 * just for sequential callers.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/signing-otp/request.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

vi.stubEnv("AUTH_SECRET", "integration-test-secret")

import { SIGNING_OTP_CLIENT_REQUEST_LIMIT, SIGNING_OTP_REQUEST_LIMIT } from "./code"
import { requestSigningOtp } from "./request"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_otpreq_${t}`
const DIGEST = "a".repeat(64)

async function newClient() {
  const c = await db.client.create({
    data: {
      tenantId, idNumber: syntheticSaId(), firstName: "Budget", lastName: "Fixture",
      email: `budget-${randomUUID().slice(0, 8)}@client.invalid`, phone: "0820000000",
    },
  })
  return c
}
const ask = (client: { id: string; email: string }, subjectId: string) => requestSigningOtp({
  subject: {
    tenantId, clientId: client.id, purpose: "DOCUMENT", subjectId, documentSha256: DIGEST,
    recipient: { firstName: "Budget", lastName: "Fixture", email: client.email, whatsapp: null },
  },
  channel: "EMAIL", method: "portal", ip: null, actor: {},
})

suite("signing OTP request budget (real database)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `otpreq-${t}`, name: "Signing OTP budget IT", domain: `otpreq-${t}.signing-otp-it.test` } })
  })
  afterAll(async () => { await db.$disconnect() })

  it(`issues at most ${SIGNING_OTP_REQUEST_LIMIT.limit} challenges for one subject under 20 parallel requests`, async () => {
    const client = await newClient()
    const results = await Promise.all(Array.from({ length: 20 }, () => ask(client, "doc-parallel")))
    const rows = await db.signingOtpChallenge.count({ where: { tenantId, clientId: client.id } })
    expect(rows).toBe(SIGNING_OTP_REQUEST_LIMIT.limit)
    expect(results.filter((r) => !r.ok && r.status === 429)).toHaveLength(20 - SIGNING_OTP_REQUEST_LIMIT.limit)
  })

  it(`caps one client at ${SIGNING_OTP_CLIENT_REQUEST_LIMIT.limit} challenges across all subjects, also in parallel`, async () => {
    const client = await newClient()
    const subjects = Array.from({ length: 6 }, (_, i) => `doc-spread-${i}`)
    const results = await Promise.all(subjects.flatMap((s) => [ask(client, s), ask(client, s), ask(client, s)]))
    const rows = await db.signingOtpChallenge.count({ where: { tenantId, clientId: client.id } })
    expect(rows).toBe(SIGNING_OTP_CLIENT_REQUEST_LIMIT.limit)
    expect(results.filter((r) => !r.ok && r.status === 429)).toHaveLength(18 - SIGNING_OTP_CLIENT_REQUEST_LIMIT.limit)
  })

  it("never leaves a challenge PENDING once the send has returned", async () => {
    const client = await newClient()
    await ask(client, "doc-settled")
    const row = await db.signingOtpChallenge.findFirstOrThrow({ where: { tenantId, clientId: client.id } })
    expect(row.deliveryStatus).toBe("FAILED") // no Contact row: a definite non-send
    expect(row.sentAt).toBeNull()
    // Settled once: the delivery evidence cannot be rewritten afterwards.
    await expect(db.signingOtpChallenge.update({ where: { id: row.id }, data: { deliveryStatus: "ACCEPTED", sentAt: new Date() } }))
      .rejects.toThrow(/cannot be changed/)
  })

  it("refuses to verify a challenge whose send has not settled", async () => {
    const client = await newClient()
    const id = randomUUID()
    await db.signingOtpChallenge.create({
      data: {
        id, tenantId, clientId: client.id, purpose: "DOCUMENT", subjectId: "doc-pending", documentSha256: DIGEST,
        codeHash: "0".repeat(64), channel: "EMAIL", maskedDestination: "b***t@c***.invalid", deliveryStatus: "PENDING",
        expiresAt: new Date(Date.now() + 300_000), maxAttempts: 5,
      },
    })
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { attempts: 1, verifiedAt: new Date() } }))
      .rejects.toThrow(/SigningOtpChallenge_verified_check/)
  })
})
