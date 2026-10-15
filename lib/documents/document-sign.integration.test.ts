/**
 * Real-Postgres proof that a generic document is signed once: two concurrent
 * signatures on the same pending document produce one signature, one audit
 * row and one access-log row (the guarded claim in
 * app/api/documents/[id]/sign), and a signing OTP is spent only by the winner.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/documents/document-sign.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { syntheticSaId } from "@/lib/bureau-submission/bureau.integration-fixture"
import { verifiedSigningOtp } from "@/lib/signing-otp/signing-otp.integration-fixture"

const h = vi.hoisted(() => ({ caller: null as null | Record<string, unknown>, session: null as null | { user: Record<string, unknown> } }))
vi.mock("@/lib/document-auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/document-auth")>()),
  getDocumentCaller: async () => h.caller,
}))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { POST } from "@/app/api/documents/[id]/sign/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_docsign_${t}`
const domain = `docsign-${t}.document-sign-it.test`
let clientId = ""

async function pendingDocument(contentSha256: string | null): Promise<string> {
  const id = `doc_${randomUUID()}`
  await db.clientDocument.create({
    data: {
      id, tenantId, clientId, docType: "OTHER", fileUrl: "/synthetic", fileName: "synthetic.pdf",
      contentSha256, signatureState: "pending", signatureRequestedAt: new Date(),
    },
  })
  return id
}
const sign = (id: string, body: Record<string, unknown>) => POST(
  new NextRequest(`http://${domain}/api/documents/${id}/sign`, {
    method: "POST", headers: { host: domain, "content-type": "application/json" }, body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
)

suite("document signing is claimed once (real database)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `docsign-${t}`, name: "Document sign IT", domain } })
    const client = await db.client.create({
      data: { tenantId, idNumber: syntheticSaId(), firstName: "Doc", lastName: "Fixture", email: `doc-${t}@client.invalid`, phone: "0820000000" },
    })
    clientId = client.id
    h.caller = { type: "client", clientId, email: client.email }
    h.session = { user: { id: clientId, role: "CLIENT", email: client.email, tenantId } }
  })
  afterAll(async () => { await db.$disconnect() })

  it("lets exactly one of two concurrent signatures through, and spends only its code", async () => {
    const digest = "d".repeat(64)
    const id = await pendingDocument(digest)
    const binding = { tenantId, clientId, purpose: "DOCUMENT" as const, subjectId: id, documentSha256: digest }
    const [a, b] = [await verifiedSigningOtp(db, binding), await verifiedSigningOtp(db, binding)]

    const statuses = (await Promise.all([
      sign(id, { method: "portal", signingOtpChallengeId: a }),
      sign(id, { method: "portal", signingOtpChallengeId: b }),
    ])).map((r) => r.status).sort()

    expect(statuses).toEqual([200, 409])
    expect(await db.auditLog.count({ where: { tenantId, entityId: id, action: "DOCUMENT_SIGNED" } })).toBe(1)
    expect(await db.documentAccessLog.count({ where: { documentId: id, action: "signed" } })).toBe(1)
    expect(await db.signingOtpChallenge.count({ where: { id: { in: [a, b] }, consumedAt: { not: null } } })).toBe(1)
  })

  it("refuses to sign a document already signed, with nothing written", async () => {
    const digest = "e".repeat(64)
    const id = await pendingDocument(digest)
    const binding = { tenantId, clientId, purpose: "DOCUMENT" as const, subjectId: id, documentSha256: digest }
    expect((await sign(id, { method: "portal", signingOtpChallengeId: await verifiedSigningOtp(db, binding) })).status).toBe(200)
    expect((await sign(id, { method: "portal", signingOtpChallengeId: await verifiedSigningOtp(db, binding) })).status).toBe(409)
    expect(await db.auditLog.count({ where: { tenantId, entityId: id, action: "DOCUMENT_SIGNED" } })).toBe(1)
  })
})
