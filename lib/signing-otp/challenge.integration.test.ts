/**
 * Real-Postgres proof of the signing OTP lifecycle and of the database floor
 * under it (migration w3_signing_otp_access_control): expiry, attempt limit
 * (also under concurrency), single use, binding to client + subject + bytes,
 * no SMS, and a consumed challenge frozen as signature evidence.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/signing-otp/challenge.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

vi.stubEnv("AUTH_SECRET", "integration-test-secret")

import { prisma } from "@/lib/prisma"
import { hashSigningOtp } from "./code"
import { consumeSigningOtp, SigningOtpRefusedError, verifySigningOtp } from "./challenge"
import { requestSigningOtp } from "./request"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_otp_${t}`
const DIGEST = "a".repeat(64)
let clientId = ""

async function challenge(over: Record<string, unknown> = {}) {
  const id = randomUUID()
  const now = Date.now()
  await db.signingOtpChallenge.create({
    data: {
      id, tenantId, clientId, purpose: "AGREEMENT", subjectId: "app-1", documentSha256: DIGEST,
      codeHash: hashSigningOtp(id, "123456"), channel: "EMAIL", maskedDestination: "o***p@c***.invalid",
      deliveryStatus: "ACCEPTED", sentAt: new Date(now), expiresAt: new Date(now + 5 * 60_000), maxAttempts: 5,
      ...over,
    },
  })
  return id
}
const binding = () => ({ tenantId, clientId, purpose: "AGREEMENT" as const, subjectId: "app-1", documentSha256: DIGEST })
const verify = (challengeId: string, code: string) => verifySigningOtp(prisma, { tenantId, clientId, challengeId, code })
const consume = (challengeId: string, over: Partial<ReturnType<typeof binding>> = {}) =>
  prisma.$transaction((tx) => consumeSigningOtp(tx, { ...binding(), ...over, challengeId, method: "portal", now: new Date() }))

suite("signing OTP lifecycle (real database)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `otp-${t}`, name: "Signing OTP IT", domain: `otp-${t}.signing-otp-it.test` } })
    const client = await db.client.create({
      data: { tenantId, idNumber: syntheticSaId(), firstName: "Otp", lastName: "Fixture", email: `otp-${t}@client.invalid`, phone: "0820000000" },
    })
    clientId = client.id
  })
  afterAll(async () => { await db.$disconnect() })

  it("verifies the right code once, then a signature spends it exactly once", async () => {
    const id = await challenge()
    expect(await verify(id, "123456")).toEqual({ ok: true })
    const evidence = await consume(id)
    expect(evidence).toMatchObject({ challengeId: id, channel: "EMAIL", attempts: 1, deliveryStatus: "ACCEPTED" })
    await expect(consume(id)).rejects.toMatchObject({ reason: "already_used" })
    expect(await verify(id, "123456")).toEqual({ ok: false, reason: "already_used" })
  })

  it("will not sign with a code that was never verified", async () => {
    const id = await challenge()
    await expect(consume(id)).rejects.toBeInstanceOf(SigningOtpRefusedError)
    await expect(consume(id)).rejects.toMatchObject({ reason: "not_verified" })
  })

  it("will not sign other bytes, another subject or another client with a verified code", async () => {
    const id = await challenge()
    await verify(id, "123456")
    await expect(consume(id, { documentSha256: "b".repeat(64) })).rejects.toMatchObject({ reason: "document_changed" })
    await expect(consume(id, { subjectId: "app-2" })).rejects.toMatchObject({ reason: "not_found" })
    await expect(consume(id, { clientId: "someone-else" })).rejects.toMatchObject({ reason: "not_found" })
    // Still unspent: the refusals changed nothing.
    expect(await consume(id)).toMatchObject({ challengeId: id })
  })

  it("expires: a code past expiresAt cannot be verified, and the database refuses to mark it verified", async () => {
    const id = await challenge({ sentAt: new Date(Date.now() - 6 * 60_000), expiresAt: new Date(Date.now() - 60_000) })
    expect(await verify(id, "123456")).toEqual({ ok: false, reason: "expired" })
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { attempts: 1, verifiedAt: new Date() } }))
      .rejects.toThrow(/SigningOtpChallenge_verified_check/)
  })

  it("locks after five wrong codes, even for the right one", async () => {
    const id = await challenge()
    for (let left = 4; left >= 0; left--) {
      expect(await verify(id, "000000")).toEqual({ ok: false, reason: "wrong_code", attemptsLeft: left })
    }
    expect(await verify(id, "123456")).toEqual({ ok: false, reason: "locked" })
    expect((await db.signingOtpChallenge.findUniqueOrThrow({ where: { id } })).attempts).toBe(5)
  })

  it("never spends more than five attempts under parallel guessing", async () => {
    const id = await challenge()
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(id, "999999")))
    expect(results.filter((r) => !r.ok && r.reason === "wrong_code")).toHaveLength(5)
    expect((await db.signingOtpChallenge.findUniqueOrThrow({ where: { id } })).attempts).toBe(5)
  })

  it("refuses an SMS challenge outright (SMS is off by policy)", async () => {
    await expect(challenge({ channel: "SMS" })).rejects.toThrow(/SigningOtpChallenge_channel_check/)
  })

  it("freezes a consumed challenge: no update, no delete", async () => {
    const id = await challenge()
    await verify(id, "123456")
    await consume(id)
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { attempts: 5 } })).rejects.toThrow(/signature evidence/)
    await expect(db.signingOtpChallenge.delete({ where: { id } })).rejects.toThrow(/signature evidence/)
  })

  it("never lets the binding, the code hash or the delivery evidence be rewritten", async () => {
    const id = await challenge()
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { documentSha256: "c".repeat(64) } }))
      .rejects.toThrow(/cannot be changed/)
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { codeHash: "0".repeat(64) } }))
      .rejects.toThrow(/cannot be changed/)
    await db.signingOtpChallenge.update({ where: { id }, data: { attempts: 2 } })
    await expect(db.signingOtpChallenge.update({ where: { id }, data: { attempts: 1 } })).rejects.toThrow(/cannot go down/)
  })

  it("issues a code end to end (demo mailbox reveal), verifies and spends it, and counts requests in the database", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const subject = {
      tenantId, clientId, purpose: "DOCUMENT" as const, subjectId: `doc-${t}`, documentSha256: DIGEST,
      recipient: { firstName: "Otp", lastName: "Fixture", email: `otp-${t}@client.invalid`, whatsapp: null },
    }
    const issued = await requestSigningOtp({ subject, channel: "EMAIL", method: "portal", ip: "192.0.2.1", actor: {} })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    expect(issued.challenge.demoCode).toMatch(/^\d{6}$/)
    const row = await db.signingOtpChallenge.findUniqueOrThrow({ where: { id: issued.challenge.challengeId } })
    expect(row.codeHash).not.toContain(issued.challenge.demoCode!)
    expect(row).toMatchObject({ channel: "EMAIL", deliveryStatus: "SIMULATED", maskedDestination: expect.stringContaining("***") })
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(5 * 60_000)

    expect(await verifySigningOtp(prisma, { tenantId, clientId, challengeId: row.id, code: issued.challenge.demoCode! }))
      .toEqual({ ok: true })
    await prisma.$transaction((tx) => consumeSigningOtp(tx, {
      tenantId, clientId, purpose: "DOCUMENT", subjectId: subject.subjectId, documentSha256: DIGEST,
      challengeId: row.id, method: "portal", now: new Date(),
    }))

    for (let i = 0; i < 4; i++) {
      expect((await requestSigningOtp({ subject, channel: "EMAIL", method: "portal", ip: null, actor: {} })).ok).toBe(true)
    }
    expect(await requestSigningOtp({ subject, channel: "EMAIL", method: "portal", ip: null, actor: {} }))
      .toMatchObject({ ok: false, status: 429 })
    vi.unstubAllEnvs()
    vi.stubEnv("AUTH_SECRET", "integration-test-secret")
  })

  it("records an undeliverable code as FAILED and never lets it be verified", async () => {
    const subject = {
      tenantId, clientId, purpose: "DOCUMENT" as const, subjectId: `doc-failed-${t}`, documentSha256: DIGEST,
      recipient: { firstName: "Otp", lastName: "Fixture", email: `nobody-${t}@client.invalid`, whatsapp: null },
    }
    const issued = await requestSigningOtp({ subject, channel: "EMAIL", method: "portal", ip: null, actor: {} })
    expect(issued).toMatchObject({ ok: false, status: 502 })
    const row = await db.signingOtpChallenge.findFirstOrThrow({ where: { tenantId, subjectId: subject.subjectId } })
    expect(row).toMatchObject({ deliveryStatus: "FAILED", sentAt: null })
    expect(await verifySigningOtp(prisma, { tenantId, clientId, challengeId: row.id, code: "123456" }))
      .toEqual({ ok: false, reason: "delivery_failed" })
  })
})
