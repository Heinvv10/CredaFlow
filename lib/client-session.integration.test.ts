/**
 * Real-Postgres proof that a client session is ended by the database state it
 * is revalidated against: password change, portal access cleared, row deleted,
 * and a token carrying another tenant's id.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/client-session.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"

vi.stubEnv("AUTH_SECRET", "integration-test-secret")

import { clientCredentialStamp, revalidateClientPrincipal } from "./client-session"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

async function tenantWithClient(portalPassword: string | null) {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_cs_${t}`
  await db.tenant.create({ data: { id: tenantId, slug: `cs-${t}`, name: "Client Session IT", domain: `cs-${t}.client-session-it.test` } })
  const client = await db.client.create({
    data: { tenantId, idNumber: syntheticSaId(), firstName: "Session", lastName: "Fixture", email: `${t}@client.invalid`, phone: "0820000000", portalPassword },
  })
  return { tenantId, clientId: client.id }
}

suite("revalidateClientPrincipal against Postgres", () => {
  afterAll(async () => { await db.$disconnect() })

  it("accepts a session whose credential has not changed", async () => {
    const { tenantId, clientId } = await tenantWithClient("$2a$12$hash-one")
    expect(await revalidateClientPrincipal(clientId, tenantId, clientCredentialStamp(clientId, tenantId, "$2a$12$hash-one"))).toBe("valid")
  })

  it("ends the session when the portal password is replaced", async () => {
    const { tenantId, clientId } = await tenantWithClient("$2a$12$hash-one")
    const stamp = clientCredentialStamp(clientId, tenantId, "$2a$12$hash-one")
    await db.client.update({ where: { id: clientId }, data: { portalPassword: "$2a$12$hash-two" } })
    expect(await revalidateClientPrincipal(clientId, tenantId, stamp)).toBeNull()
  })

  it("ends the session when portal access is cleared", async () => {
    const { tenantId, clientId } = await tenantWithClient("$2a$12$hash-one")
    const stamp = clientCredentialStamp(clientId, tenantId, "$2a$12$hash-one")
    await db.client.update({ where: { id: clientId }, data: { portalPassword: null } })
    expect(await revalidateClientPrincipal(clientId, tenantId, stamp)).toBeNull()
  })

  it("ends the session when the Client row is deleted", async () => {
    const { tenantId, clientId } = await tenantWithClient("$2a$12$hash-one")
    const stamp = clientCredentialStamp(clientId, tenantId, "$2a$12$hash-one")
    await db.client.delete({ where: { id: clientId } })
    expect(await revalidateClientPrincipal(clientId, tenantId, stamp)).toBeNull()
  })

  it("refuses a token that names another tenant's id for the client", async () => {
    const a = await tenantWithClient("$2a$12$hash-one")
    const b = await tenantWithClient("$2a$12$hash-one")
    expect(await revalidateClientPrincipal(a.clientId, b.tenantId, clientCredentialStamp(a.clientId, b.tenantId, "$2a$12$hash-one"))).toBeNull()
  })

  it("refuses a token stamped for another client who holds the same hash", async () => {
    const a = await tenantWithClient("$2a$12$shared-hash")
    const b = await tenantWithClient("$2a$12$shared-hash")
    const stampOfA = clientCredentialStamp(a.clientId, a.tenantId, "$2a$12$shared-hash")
    expect(await revalidateClientPrincipal(b.clientId, b.tenantId, stampOfA)).toBeNull()
    expect(await revalidateClientPrincipal(a.clientId, a.tenantId, stampOfA)).toBe("valid")
  })
})
